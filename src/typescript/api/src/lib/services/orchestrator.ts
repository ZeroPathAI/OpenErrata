import { getPrisma } from "$lib/db/client";
import { requireOpenAiApiKey } from "$lib/config/env.js";
import { isRecordNotFoundError } from "$lib/db/errors.js";
import { downloadAndStoreImages, type ResolvedDownloadedImage } from "./image-downloader.js";
import { consumeOpenAiKeySource, resolveInvestigationRunKey } from "./user-key-source.js";
import { InvestigatorExecutionError, OpenAIInvestigator } from "$lib/investigators/openai.js";
import type { InvestigatorImageOccurrence } from "$lib/investigators/interface.js";
import { claimIdSchema, MAX_IMAGES_PER_INVESTIGATION } from "@openerrata/shared";
import type { ImageBlob } from "$lib/generated/prisma/client";
import { createHash } from "node:crypto";

import { formatErrorForLog, isNonRetryableProviderError } from "./orchestrator-errors.js";
import { toPromptPostContext, type PromptImageOccurrence } from "./prompt-context.js";
import { tryClaimRunLease, loadClaimedRun, startRunHeartbeat, type Logger } from "./run-lease.js";
import {
  persistAttemptAudit,
  persistFailedAttemptAndMarkInvestigationFailed,
  persistFailedAttemptAndReleaseLease,
} from "./attempt-audit.js";

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

function toDataUri(bytes: Uint8Array, mimeType: string): string {
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

export async function orchestrateInvestigation(
  runId: string,
  logger: Logger,
  options: {
    isLastAttempt: boolean;
    attemptNumber: number;
    workerIdentity: string;
  },
): Promise<void> {
  const claimResult = await tryClaimRunLease(runId, options.workerIdentity);
  if (claimResult === "MISSING") {
    logger.info(`Investigation run ${runId} no longer exists; skipping stale job`);
    return;
  }
  if (claimResult === "TERMINAL") {
    logger.info(`Investigation run ${runId} already terminal, skipping`);
    return;
  }
  if (claimResult === "LEASE_HELD") {
    logger.info(`Investigation run ${runId} already leased, skipping`);
    return;
  }

  const run = await loadClaimedRun(runId);
  if (!run) {
    logger.info(`Investigation run ${runId} disappeared after claim; skipping stale job`);
    return;
  }

  const prisma = getPrisma();
  const investigation = run.investigation;
  if (investigation.status !== "PROCESSING") {
    await prisma.investigation.update({
      where: { id: investigation.id },
      data: { status: "PROCESSING" },
    });
  }

  const heartbeat = startRunHeartbeat(run.id, options.workerIdentity, logger);

  try {
    const runKey = await resolveInvestigationRunKey(prisma, run.id);
    const investigator =
      runKey.type === "SERVER_KEY"
        ? getServerInvestigator()
        : new OpenAIInvestigator(runKey.apiKey);
    const promptPostContext = toPromptPostContext(investigation.postVersion);
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

    const output = await investigator.investigate({
      contentText: investigation.postVersion.contentBlob.contentText,
      ...promptPostContext,
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
    });

    // Guard-first: atomically transition PROCESSING → COMPLETE.
    // If another worker already moved this investigation to a terminal
    // state, the updateMany matches 0 rows and we bail without writing
    // claims or audit — the transaction commits as a no-op.
    const completed = await prisma.$transaction(async (tx) => {
      const transitioned = await tx.investigation.updateMany({
        where: { id: investigation.id, status: "PROCESSING" },
        data: {
          status: "COMPLETE",
          checkedAt: new Date(),
          modelVersion: output.modelVersion ?? null,
        },
      });

      if (transitioned.count === 0) {
        return false;
      }

      await persistAttemptAudit(tx, {
        investigationId: investigation.id,
        attemptNumber: options.attemptNumber,
        outcome: "SUCCEEDED",
        attemptAudit: output.attemptAudit,
      });

      for (const claim of output.result.claims) {
        await tx.claim.create({
          data: {
            investigationId: investigation.id,
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

      await tx.investigationRun.update({
        where: { id: run.id },
        data: {
          leaseOwner: null,
          leaseExpiresAt: null,
          recoverAfterAt: null,
          heartbeatAt: new Date(),
        },
      });

      await consumeOpenAiKeySource(tx, run.id);
      return true;
    });

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
        runId: run.id,
        investigationId: investigation.id,
        attemptNumber: options.attemptNumber,
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

    // TRANSIENT: everything else — rethrow for graphile-worker retry with backoff.
    if (options.isLastAttempt) {
      const marked = await persistFailedAttemptAndMarkInvestigationFailed({
        runId: run.id,
        investigationId: investigation.id,
        attemptNumber: options.attemptNumber,
        attemptAudit,
      });
      if (marked) {
        logger.error(
          `Investigation ${investigation.id} exhausted retries and is marked FAILED: ${formatErrorForLog(error)}`,
        );
      } else {
        logger.info(
          `Investigation ${investigation.id} no longer PROCESSING; ignoring exhausted retries`,
        );
      }
      return;
    }

    const released = await persistFailedAttemptAndReleaseLease({
      runId: run.id,
      investigationId: investigation.id,
      attemptNumber: options.attemptNumber,
      attemptAudit,
    });

    if (!released) {
      logger.info(
        `Investigation ${investigation.id} no longer PROCESSING; ignoring transient error`,
      );
      return;
    }

    logger.error(
      `Investigation ${investigation.id} transient failure: ${formatErrorForLog(error)}`,
    );
    throw error;
  } finally {
    heartbeat.stop();
  }
}
