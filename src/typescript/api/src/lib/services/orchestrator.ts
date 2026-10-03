import { getPrisma } from "$lib/db/client";
import { requireOpenAiApiKey } from "$lib/config/env.js";
import { isRecordNotFoundError } from "$lib/db/errors.js";
import { downloadAndStoreImages, type ResolvedDownloadedImage } from "./image-downloader.js";
import {
  consumeOpenAiKeySource,
  ExpiredOpenAiKeySourceError,
  InvalidOpenAiKeySourceError,
  resolveInvestigationKey,
  type InvestigationKeyResolution,
} from "./user-key-source.js";
import { InvestigatorExecutionError } from "$lib/investigators/errors.js";
import type {
  ImagePlaceholder,
  InvestigationProgressCallbacks,
  InvestigatorFactory,
  InvestigatorImageOccurrence,
  InvestigatorInput,
  InvestigatorSucceededAttemptAudit,
} from "$lib/investigators/interface.js";
import {
  claimIdSchema,
  MAX_IMAGES_PER_INVESTIGATION,
  type InvestigationResult,
  type SupportedImageMimeType,
} from "@openerrata/shared";
import type { ImageBlob, Prisma } from "$lib/db/prisma-client";

import {
  formatErrorForLog,
  getErrorStatus,
  isNonRetryableProviderError,
} from "./orchestrator-errors.js";
import {
  tryClaimLease,
  loadClaimedInvestigation,
  startLeaseHeartbeat,
  releaseLeaseDroppingUserKey,
  retryBackoffMs,
  LeaseLostError,
  MAX_INVESTIGATION_ATTEMPTS,
  type InvestigationForRun,
  type Logger,
} from "./investigation-lease.js";
import {
  persistAttemptAudit,
  persistFailedAttemptAndMarkInvestigationFailed,
  persistFailedAttemptAndReleaseLease,
} from "./attempt-audit.js";
import { enqueueInvestigation } from "./queue.js";

/**
 * OpenAI statuses that say "this user key cannot pay for this run" rather than
 * anything about the post: rejected (401), not permitted or no model access
 * (403, 404), rate-limited or out of quota (429). Retrying on the same key
 * cannot help, and letting such failures exhaust attempts or mark the
 * investigation FAILED would let a bad key block a post from ever being
 * checked — so the key is dropped instead.
 */
const USER_KEY_ATTRIBUTABLE_STATUS_CODES: ReadonlySet<number> = new Set([401, 403, 404, 429]);

/** Whether `error`, raised while running on `keyType`, means the user key is unusable. */
function isUserKeyFailure(
  error: unknown,
  keyType: InvestigationKeyResolution["type"] | null,
): boolean {
  if (
    error instanceof ExpiredOpenAiKeySourceError ||
    error instanceof InvalidOpenAiKeySourceError
  ) {
    return true;
  }
  if (keyType !== "USER_OPENAI_KEY") {
    return false;
  }
  const status = getErrorStatus(error);
  return status !== null && USER_KEY_ATTRIBUTABLE_STATUS_CODES.has(status);
}

/** Replace the investigation's image set, provided this worker still holds the lease. */
async function replaceInvestigationImages(
  lease: { investigationId: string; workerIdentity: string; leaseLostSignal: AbortSignal },
  imageBlobs: ImageBlob[],
): Promise<void> {
  const { investigationId } = lease;
  const uniqueBlobs = [...new Map(imageBlobs.map((b) => [b.id, b])).values()];

  lease.leaseLostSignal.throwIfAborted();
  await getPrisma().$transaction(async (tx) => {
    // Lock and verify our lease row so a reclaimed run cannot clobber images.
    const held = await tx.investigationLease.updateMany({
      where: { investigationId, leaseOwner: lease.workerIdentity },
      data: { heartbeatAt: new Date() },
    });
    if (held.count === 0) {
      throw new LeaseLostError(investigationId, "lease not held when writing images");
    }

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

/**
 * Canonical form of an image URL, shared by image occurrences, markdown
 * placeholders and downloads so they match each other. Null for URLs that can
 * never be fetched.
 */
function canonicalImageUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
}

interface StoredImageOccurrence {
  originalIndex: number;
  normalizedTextOffset: number;
  sourceUrl: string;
  captionText: string | null;
}

async function resolvePromptImageOccurrences(
  lease: { investigationId: string; workerIdentity: string; leaseLostSignal: AbortSignal },
  storedOccurrences: StoredImageOccurrence[],
): Promise<InvestigatorImageOccurrence[]> {
  const imageOccurrences = storedOccurrences.map((occurrence) => ({
    originalIndex: occurrence.originalIndex,
    normalizedTextOffset: occurrence.normalizedTextOffset,
    sourceUrl: canonicalImageUrl(occurrence.sourceUrl) ?? occurrence.sourceUrl,
    fetchable: canonicalImageUrl(occurrence.sourceUrl) !== null,
    ...(occurrence.captionText === null ? {} : { captionText: occurrence.captionText }),
  }));

  const uniqueSourceUrls = [
    ...new Set(
      imageOccurrences
        .filter((occurrence) => occurrence.fetchable)
        .map((occurrence) => occurrence.sourceUrl),
    ),
  ];
  const urlsWithinBudget = uniqueSourceUrls.slice(0, MAX_IMAGES_PER_INVESTIGATION);
  const omittedSourceUrls = new Set(uniqueSourceUrls.slice(MAX_IMAGES_PER_INVESTIGATION));

  const resolutions = await downloadAndStoreImages(urlsWithinBudget, lease.leaseLostSignal);

  const resolvedBySourceUrl = new Map<string, ResolvedDownloadedImage>();
  const uniqueResolvedBlobs = new Map<string, ResolvedDownloadedImage>();

  for (const resolution of resolutions) {
    if (resolution.status !== "resolved") continue;
    resolvedBySourceUrl.set(resolution.sourceUrl, resolution.image);
    uniqueResolvedBlobs.set(resolution.image.blob.id, resolution.image);
  }

  await replaceInvestigationImages(
    lease,
    Array.from(uniqueResolvedBlobs.values()).map((image) => image.blob),
  );

  return imageOccurrences.map(({ fetchable: _fetchable, ...occurrence }) => {
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
 * Investigator input for a claimed run, built from the immutable
 * InvestigationInput snapshot plus the version's text and resolved images.
 */
function buildInvestigatorInput(
  investigation: InvestigationForRun,
  imageOccurrences: InvestigatorImageOccurrence[],
): InvestigatorInput {
  const { input } = investigation;
  const imagePlaceholders: ImagePlaceholder[] = input.imagePlaceholderSourceUrls.map(
    (sourceUrl, index) => ({ index, matchBy: "SOURCE_URL", sourceUrl }),
  );
  const base = {
    contentText: investigation.postVersion.contentBlob.contentText,
    ...(input.markdown === null ? {} : { contentMarkdown: input.markdown, imagePlaceholders }),
    platform: investigation.postVersion.post.platform,
    url: input.postUrl,
    ...(input.authorName === null ? {} : { authorName: input.authorName }),
    ...(input.postPublishedAt === null
      ? {}
      : { postPublishedAt: input.postPublishedAt.toISOString() }),
    imageOccurrences,
    ...(input.hasVideo ? { hasVideo: true } : {}),
  };

  if (investigation.parentInvestigationId === null) {
    return base;
  }
  if (investigation.parentInvestigation === null) {
    throw new Error(`Update investigation ${investigation.id} is missing parent investigation`);
  }
  return {
    ...base,
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
  };
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
    attemptAudit: InvestigatorSucceededAttemptAudit;
    /** Provider model id the fact-check ran on (INV-INV-MODEL-AT-COMPLETION). */
    model: string;
    modelVersion: string;
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
      model: params.model,
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
    createInvestigator: InvestigatorFactory;
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
  switch (claimResult.outcome) {
    case "MISSING":
      logger.info(`Investigation ${investigationId} no longer exists; skipping stale job`);
      return;
    case "TERMINAL":
      logger.info(`Investigation ${investigationId} already terminal, skipping`);
      return;
    case "LEASE_HELD":
      logger.info(`Investigation ${investigationId} already leased, skipping`);
      return;
    case "UNFUNDED":
      logger.info(
        `Investigation ${investigationId} has no funding since its user key was dropped; skipping`,
      );
      return;
    case "CLAIMED":
      break;
  }

  const { attemptNumber } = claimResult;

  const investigation = await loadClaimedInvestigation(investigationId);
  if (!investigation) {
    logger.info(`Investigation ${investigationId} disappeared after claim; skipping stale job`);
    return;
  }

  const prisma = getPrisma();

  const heartbeat = startLeaseHeartbeat(
    {
      investigationId,
      workerIdentity: options.workerIdentity,
      leaseExpiresAt: claimResult.leaseExpiresAt,
    },
    logger,
  );
  // Aborts when this worker loses the lease, which stops every in-flight
  // provider request, tool fetch and image download of this run.
  const { leaseLostSignal } = heartbeat;
  const lease = {
    investigationId: investigation.id,
    workerIdentity: options.workerIdentity,
    leaseLostSignal,
  };

  let investigationKeyType: InvestigationKeyResolution["type"] | null = null;
  try {
    // Resolve the key before touching any attacker-chosen image URL: a
    // user-key run whose key is unusable stops here.
    const investigationKey = await resolveInvestigationKey(prisma, investigation);
    investigationKeyType = investigationKey.type;
    const investigator = options.createInvestigator(
      investigationKey.type === "SERVER_KEY" ? requireOpenAiApiKey() : investigationKey.apiKey,
    );

    const resolvedImageOccurrences = await resolvePromptImageOccurrences(
      lease,
      investigation.postVersion.imageOccurrenceSet.occurrences,
    );
    const investigatorInput = buildInvestigatorInput(investigation, resolvedImageOccurrences);

    const progressCallbacks: InvestigationProgressCallbacks = {
      onProgressUpdate: (pending, confirmed) => {
        if (leaseLostSignal.aborted) return;
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

    const output = await investigator.investigate(investigatorInput, {
      signal: leaseLostSignal,
      callbacks: progressCallbacks,
    });

    // Ensure all progress writes settle before terminal transition.
    await flushProgressWrites();

    leaseLostSignal.throwIfAborted();
    const completed = await prisma.$transaction((tx) =>
      persistCompletedInvestigation(tx, {
        investigationId: investigation.id,
        workerIdentity: options.workerIdentity,
        claims: output.result.claims,
        attemptNumber,
        attemptAudit: output.attemptAudit,
        model: output.model,
        modelVersion: output.modelVersion,
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

    if (leaseLostSignal.aborted || error instanceof LeaseLostError) {
      logger.warn(
        `Investigation ${investigation.id} attempt ${attemptNumber.toString()} abandoned: ${formatErrorForLog(leaseLostSignal.aborted ? leaseLostSignal.reason : error)}`,
      );
      return;
    }

    if (isRecordNotFoundError(error)) {
      logger.info(
        `Investigation ${investigation.id} disappeared during processing; skipping stale job`,
      );
      return;
    }

    const attemptAudit = error instanceof InvestigatorExecutionError ? error.attemptAudit : null;

    // USER KEY UNUSABLE: drop the key; the investigation waits, unfunded, for
    // the selector or a new request instead of failing.
    if (isUserKeyFailure(error, investigationKeyType)) {
      const released = await releaseLeaseDroppingUserKey({
        investigationId: investigation.id,
        workerIdentity: options.workerIdentity,
        attemptNumber,
        attemptAudit,
      });
      if (released) {
        logger.warn(
          `Investigation ${investigation.id} dropped its user OpenAI key and is unfunded: ${formatErrorForLog(error)}`,
        );
      } else {
        logger.info(
          `Investigation ${investigation.id} no longer PROCESSING; ignoring user key failure`,
        );
      }
      return;
    }

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
    const backoffMs = retryBackoffMs(attemptNumber);
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
