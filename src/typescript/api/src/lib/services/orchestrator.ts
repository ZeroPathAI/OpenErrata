import { getPrisma } from "$lib/db/client";
import { requireOpenAiApiKey } from "$lib/config/env.js";
import { isRecordNotFoundError } from "$lib/db/errors.js";
import { downloadAndStoreImages, type ResolvedDownloadedImage } from "./image-downloader.js";
import { consumeOpenAiKeySource, resolveInvestigationKey } from "./user-key-source.js";
import { InvestigatorExecutionError, OpenAIInvestigator } from "$lib/investigators/openai.js";
import type {
  InvestigationProgressCallbacks,
  InvestigatorAttemptAudit,
  InvestigatorImageOccurrence,
} from "$lib/investigators/interface.js";
import {
  claimIdSchema,
  MAX_IMAGES_PER_INVESTIGATION,
  type InvestigationResult,
  type SupportedImageMimeType,
} from "@openerrata/shared";
import type { ImageBlob, Prisma } from "$lib/db/prisma-client";
import { createHash } from "node:crypto";

import { formatErrorForLog, isNonRetryableProviderError } from "./orchestrator-errors.js";
import { toPromptPostContext, type PromptImageOccurrence } from "./prompt-context.js";
import {
  tryClaimLease,
  loadClaimedInvestigation,
  startHeartbeat,
  MAX_INVESTIGATION_ATTEMPTS,
  BASE_BACKOFF_MS,
  type Logger,
} from "./investigation-lease.js";
import {
  persistAttemptAudit,
  persistFailedAttemptAndMarkInvestigationFailed,
  persistFailedAttemptAndReleaseLease,
} from "./attempt-audit.js";
import { extractImagePlaceholdersFromMarkdown } from "./markdown-resolution.js";
import { enqueueInvestigation } from "./queue.js";

let serverInvestigator: OpenAIInvestigator | null = null;

function getServerInvestigator(): OpenAIInvestigator {
  if (serverInvestigator) {
    return serverInvestigator;
  }

  serverInvestigator = new OpenAIInvestigator(requireOpenAiApiKey());
  return serverInvestigator;
}

function hashSnapshotText(snapshotText: string): string {
  return createHash("sha256").update(snapshotText).digest("hex");
}

async function replaceInvestigationImages(
  investigationId: string,
  imageBlobs: ImageBlob[],
): Promise<void> {
  const uniqueBlobs = [...new Map(imageBlobs.map((b) => [b.id, b])).values()];

  await getPrisma().$transaction(async (tx) => {
    await tx.investigationImage.deleteMany({
      where: { investigationId },
    });

    for (const [imageOrder, imageBlob] of uniqueBlobs.entries()) {
      await tx.investigationImage.create({
        data: {
          investigationId,
          imageBlobId: imageBlob.id,
          imageOrder,
        },
      });
    }
  });
}

function toDataUri(bytes: Uint8Array, mimeType: SupportedImageMimeType): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function uniqueUrlsInOrder(urls: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
  }

  return unique;
}

async function resolvePromptImageOccurrences(
  investigationId: string,
  imageOccurrences: PromptImageOccurrence[],
): Promise<InvestigatorImageOccurrence[]> {
  if (imageOccurrences.length === 0) {
    await replaceInvestigationImages(investigationId, []);
    return [];
  }

  const uniqueSourceUrls = uniqueUrlsInOrder(
    imageOccurrences.map((occurrence) => occurrence.sourceUrl),
  );
  const urlsWithinBudget = uniqueSourceUrls.slice(0, MAX_IMAGES_PER_INVESTIGATION);
  const omittedSourceUrls = new Set(uniqueSourceUrls.slice(MAX_IMAGES_PER_INVESTIGATION));

  const resolutions = await downloadAndStoreImages(urlsWithinBudget, MAX_IMAGES_PER_INVESTIGATION);

  const resolvedBySourceUrl = new Map<string, ResolvedDownloadedImage>();
  const uniqueResolvedBlobs = new Map<string, ResolvedDownloadedImage>();

  for (const resolution of resolutions) {
    if (resolution.status !== "resolved") continue;
    resolvedBySourceUrl.set(resolution.sourceUrl, resolution.image);
    uniqueResolvedBlobs.set(resolution.image.blob.id, resolution.image);
  }

  await replaceInvestigationImages(
    investigationId,
    Array.from(uniqueResolvedBlobs.values()).map((image) => image.blob),
  );

  return imageOccurrences.map((occurrence) => {
    if (omittedSourceUrls.has(occurrence.sourceUrl)) {
      return {
        ...occurrence,
        resolution: "omitted" as const,
      };
    }

    const resolved = resolvedBySourceUrl.get(occurrence.sourceUrl);
    if (!resolved) {
      return {
        ...occurrence,
        resolution: "missing" as const,
      };
    }

    return {
      ...occurrence,
      resolution: "resolved" as const,
      imageDataUri: toDataUri(resolved.bytes, resolved.mimeType),
      contentHash: resolved.contentHash,
    };
  });
}

/**
 * Guard-first persist: atomically transition PROCESSING → COMPLETE.
 *
 * Two-step guard:
 * 1. Delete the InvestigationLease row matching our workerIdentity. If
 *    deleteMany returns 0 (another worker reclaimed or investigation already
 *    terminal), return false without writing claims or audit.
 * 2. Defensive updateMany with status=PROCESSING — asserts the structural
 *    invariant that lease existence implies PROCESSING. Throws on violation.
 *
 * The lease deletion also cleans up progressClaims (stored on the lease row).
 *
 * Exported for testability: the guard pattern is a critical concurrency
 * invariant that prevents duplicate claim writes when two workers race.
 */
export async function persistCompletedInvestigation(
  tx: Prisma.TransactionClient,
  params: {
    investigationId: string;
    workerIdentity: string;
    claims: InvestigationResult["claims"];
    attemptNumber: number;
    attemptAudit: InvestigatorAttemptAudit;
    modelVersion: string | null;
  },
): Promise<boolean> {
  const released = await tx.investigationLease.deleteMany({
    where: {
      investigationId: params.investigationId,
      leaseOwner: params.workerIdentity,
    },
  });

  if (released.count === 0) {
    return false;
  }

  const transitioned = await tx.investigation.updateMany({
    where: { id: params.investigationId, status: "PROCESSING" },
    data: {
      status: "COMPLETE",
      checkedAt: new Date(),
      modelVersion: params.modelVersion,
    },
  });

  if (transitioned.count === 0) {
    throw new Error(
      `Invariant violation: lease existed for investigation ${params.investigationId} but status was not PROCESSING`,
    );
  }

  await persistAttemptAudit(tx, {
    investigationId: params.investigationId,
    attemptNumber: params.attemptNumber,
    attemptAudit: params.attemptAudit,
  });

  for (const claim of params.claims) {
    await tx.claim.create({
      data: {
        investigationId: params.investigationId,
        text: claim.text,
        context: claim.context,
        summary: claim.summary,
        reasoning: claim.reasoning,
        sources: {
          create: claim.sources.map((s) => ({
            url: s.url,
            title: s.title,
            snippet: s.snippet,
            snapshotText: s.snippet,
            snapshotHash: hashSnapshotText(s.snippet),
            retrievedAt: new Date(),
          })),
        },
      },
    });
  }

  await consumeOpenAiKeySource(tx, params.investigationId);
  return true;
}

export async function orchestrateInvestigation(
  investigationId: string,
  logger: Logger,
  options: {
    workerIdentity: string;
  },
): Promise<void> {
  const inFlightProgressWrites = new Set<Promise<void>>();
  let progressWriteFailures = 0;

  function trackProgressWrite(write: Promise<void>): void {
    inFlightProgressWrites.add(write);
    void write.finally(() => {
      inFlightProgressWrites.delete(write);
    });
  }

  async function flushProgressWrites(): Promise<void> {
    if (inFlightProgressWrites.size === 0) {
      return;
    }
    await Promise.allSettled([...inFlightProgressWrites]);
  }

  const claimResult = await tryClaimLease(investigationId, options.workerIdentity);
  if (claimResult.outcome === "MISSING") {
    logger.info(`Investigation ${investigationId} no longer exists; skipping stale job`);
    return;
  }
  if (claimResult.outcome === "TERMINAL") {
    logger.info(`Investigation ${investigationId} already terminal, skipping`);
    return;
  }
  if (claimResult.outcome === "LEASE_HELD") {
    logger.info(`Investigation ${investigationId} already leased, skipping`);
    return;
  }
  if (claimResult.outcome === "ATTEMPTS_EXHAUSTED") {
    logger.error(
      `Investigation ${investigationId} exhausted ${MAX_INVESTIGATION_ATTEMPTS.toString()} attempts; marking FAILED`,
    );
    const prismaForExhausted = getPrisma();
    await prismaForExhausted.$transaction(async (tx) => {
      const now = new Date();
      // Defensive cleanup for stale/expired leases. Active leases are preserved.
      await tx.investigationLease.deleteMany({
        where: {
          investigationId,
          leaseExpiresAt: { lte: now },
        },
      });
      // Match both PENDING (normal exhaustion path) and PROCESSING with no
      // active lease row (stale reclaim rollback path). Avoid marking FAILED
      // while another worker still holds an active lease.
      const transitioned = await tx.investigation.updateMany({
        where: {
          id: investigationId,
          attemptCount: { gte: MAX_INVESTIGATION_ATTEMPTS },
          OR: [{ status: "PENDING" }, { status: "PROCESSING", lease: { is: null } }],
        },
        data: { status: "FAILED" },
      });
      if (transitioned.count > 0) {
        await consumeOpenAiKeySource(tx, investigationId);
      }
    });
    return;
  }

  const { attemptNumber } = claimResult;

  const investigation = await loadClaimedInvestigation(investigationId);
  if (!investigation) {
    logger.info(`Investigation ${investigationId} disappeared after claim; skipping stale job`);
    return;
  }

  const prisma = getPrisma();

  const heartbeat = startHeartbeat(investigationId, options.workerIdentity, logger);

  try {
    const investigationKey = await resolveInvestigationKey(prisma, investigationId);
    const investigator =
      investigationKey.type === "SERVER_KEY"
        ? getServerInvestigator()
        : new OpenAIInvestigator(investigationKey.apiKey);
    const promptPostContext = toPromptPostContext(investigation.postVersion);

    // ── Resolve or restore InvestigationInput snapshot ──
    // All executions (first attempt and retries) must use the immutable
    // InvestigationInput snapshot persisted at queue-time.
    const contentMarkdown = investigation.input.markdown ?? undefined;
    const imagePlaceholders =
      contentMarkdown !== undefined
        ? extractImagePlaceholdersFromMarkdown(contentMarkdown)
        : undefined;

    const resolvedImageOccurrences = await resolvePromptImageOccurrences(
      investigation.id,
      promptPostContext.imageOccurrences,
    );

    if (
      investigation.parentInvestigationId !== null &&
      investigation.parentInvestigation === null
    ) {
      throw new Error(`Update investigation ${investigation.id} is missing parent investigation`);
    }

    const progressCallbacks: InvestigationProgressCallbacks = {
      onProgressUpdate: (pending, confirmed) => {
        // Guard on leaseOwner to avoid writing progressClaims after a
        // terminal transition or lease reclaim (the lease row won't exist).
        const write = prisma.investigationLease
          .updateMany({
            where: {
              investigationId: investigation.id,
              leaseOwner: options.workerIdentity,
            },
            data: { progressClaims: { pending, confirmed } },
          })
          .then(() => undefined)
          .catch((err: unknown) => {
            progressWriteFailures += 1;
            console.warn("progressClaims write failed:", err);
          });
        trackProgressWrite(write);
      },
    };

    const output = await investigator.investigate(
      {
        contentText: investigation.postVersion.contentBlob.contentText,
        ...promptPostContext,
        ...(contentMarkdown !== undefined && { contentMarkdown }),
        ...(imagePlaceholders !== undefined && { imagePlaceholders }),
        imageOccurrences: resolvedImageOccurrences,
        ...(promptPostContext.hasVideo ? { hasVideo: true } : {}),
        ...(investigation.parentInvestigation !== null && {
          isUpdate: true,
          ...(investigation.contentDiff === null ? {} : { contentDiff: investigation.contentDiff }),
          oldClaims: investigation.parentInvestigation.claims.map((claim) => ({
            id: claimIdSchema.parse(claim.id),
            text: claim.text,
            context: claim.context,
            summary: claim.summary,
            reasoning: claim.reasoning,
            sources: claim.sources.map((source) => ({
              url: source.url,
              title: source.title,
              snippet: source.snippet,
            })),
          })),
        }),
      },
      progressCallbacks,
    );

    // Ensure all progress writes settle before terminal transition.
    await flushProgressWrites();

    const completed = await prisma.$transaction((tx) =>
      persistCompletedInvestigation(tx, {
        investigationId: investigation.id,
        workerIdentity: options.workerIdentity,
        claims: output.result.claims,
        attemptNumber,
        attemptAudit: output.attemptAudit,
        modelVersion: output.modelVersion ?? null,
      }),
    );

    if (completed) {
      logger.info(
        `Investigation ${investigation.id} completed with ${output.result.claims.length} claims`,
      );
    } else {
      logger.info(
        `Investigation ${investigation.id} no longer PROCESSING; discarding duplicate result`,
      );
    }
  } catch (error) {
    // Drain callback writes so FAILED/lease-release transition is the final state.
    await flushProgressWrites();

    if (isRecordNotFoundError(error)) {
      logger.info(
        `Investigation ${investigation.id} disappeared during processing; skipping stale job`,
      );
      return;
    }

    const attemptAudit = error instanceof InvestigatorExecutionError ? error.attemptAudit : null;

    // NON_RETRYABLE: deterministic provider or parsing failures.
    if (isNonRetryableProviderError(error)) {
      const marked = await persistFailedAttemptAndMarkInvestigationFailed({
        investigationId: investigation.id,
        workerIdentity: options.workerIdentity,
        attemptNumber,
        attemptAudit,
      });
      if (marked) {
        logger.error(
          `Investigation ${investigation.id} failed non-retryable provider output: ${formatErrorForLog(error)}`,
        );
      } else {
        logger.info(
          `Investigation ${investigation.id} no longer PROCESSING; ignoring non-retryable error`,
        );
      }
      return;
    }

    // TRANSIENT: if this was the last allowed attempt, mark FAILED with
    // full audit trail (the worker that experienced the error writes it).
    if (attemptNumber >= MAX_INVESTIGATION_ATTEMPTS) {
      const marked = await persistFailedAttemptAndMarkInvestigationFailed({
        investigationId: investigation.id,
        workerIdentity: options.workerIdentity,
        attemptNumber,
        attemptAudit,
      });
      if (marked) {
        logger.error(
          `Investigation ${investigation.id} exhausted ${MAX_INVESTIGATION_ATTEMPTS.toString()} attempts and is marked FAILED: ${formatErrorForLog(error)}`,
        );
      } else {
        logger.info(
          `Investigation ${investigation.id} no longer PROCESSING; ignoring exhausted retries`,
        );
      }
      return;
    }

    // Not last attempt — reclaim to PENDING and explicitly re-enqueue.
    // Do NOT rethrow to graphile-worker — we control retry timing ourselves.
    const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attemptNumber - 1);
    const retryAfter = new Date(Date.now() + backoffMs);

    const released = await persistFailedAttemptAndReleaseLease({
      investigationId: investigation.id,
      workerIdentity: options.workerIdentity,
      attemptNumber,
      attemptAudit,
      retryAfter,
    });

    if (!released) {
      logger.info(
        `Investigation ${investigation.id} no longer PROCESSING; ignoring transient error`,
      );
      return;
    }

    logger.error(
      `Investigation ${investigation.id} transient failure (attempt ${attemptNumber.toString()}/${MAX_INVESTIGATION_ATTEMPTS.toString()}), reclaimed to PENDING, retry in ${(backoffMs / 1000).toString()}s: ${formatErrorForLog(error)}`,
    );

    // Re-enqueue with per-investigation jobKey and backoff delay.
    // The retryAfter field on Investigation prevents the selector from
    // re-enqueueing immediately, which would defeat the backoff via
    // graphile-worker's jobKey replacement semantics.
    await enqueueInvestigation(investigation.id, { runAt: retryAfter });
  } finally {
    heartbeat.stop();
    if (progressWriteFailures > 0) {
      logger.warn(
        `${progressWriteFailures.toString()} progressClaims write(s) failed during investigation ${investigation.id}`,
      );
    }
  }
}
