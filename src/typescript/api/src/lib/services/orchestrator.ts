import { getPrisma } from "$lib/db/client";
import { requireOpenAiApiKey } from "$lib/config/env.js";
import { isRecordNotFoundError } from "$lib/db/errors.js";
import {
  isNonRetryableOpenAiStatusCode,
  readOpenAiStatusCode,
} from "$lib/openai/errors.js";
import { downloadAndStoreImages } from "./image-downloader.js";
import {
  consumeOpenAiKeySource,
  ExpiredOpenAiKeySourceError,
  InvalidOpenAiKeySourceError,
  resolveInvestigationRunKey,
} from "./user-key-source.js";
import {
  InvestigatorExecutionError,
  InvestigatorStructuredOutputError,
  OpenAIInvestigator,
} from "$lib/investigators/openai.js";
import {
  parseInvestigatorAttemptAudit,
  type InvestigatorAttemptAudit,
} from "$lib/investigators/interface.js";
import type {
  ImageBlob,
  Prisma,
} from "$lib/generated/prisma/client";
import { createHash } from "node:crypto";
import { ZodError } from "zod";
import { MAX_IMAGES_PER_INVESTIGATION } from "@openerrata/shared";

interface Logger {
  info(msg: string): void;
  error(msg: string): void;
}

const RUN_LEASE_TTL_MS = 60_000;
const RUN_HEARTBEAT_INTERVAL_MS = 15_000;

let serverInvestigator: OpenAIInvestigator | null = null;

function getServerInvestigator(): OpenAIInvestigator {
  if (serverInvestigator) {
    return serverInvestigator;
  }

  serverInvestigator = new OpenAIInvestigator(requireOpenAiApiKey());
  return serverInvestigator;
}
const investigationContextInclude = {
  post: {
    select: {
      platform: true,
      url: true,
      author: { select: { displayName: true } },
      lesswrongMeta: { select: { publishedAt: true, imageUrls: true } },
      xMeta: { select: { postedAt: true, mediaUrls: true } },
      substackMeta: { select: { publishedAt: true, imageUrls: true } },
    },
  },
} satisfies Prisma.InvestigationInclude;
type InvestigationWithContext = Prisma.InvestigationGetPayload<{
  include: typeof investigationContextInclude;
}>;
type InvestigationPostContext = InvestigationWithContext["post"];
const runContextInclude = {
  investigation: {
    include: investigationContextInclude,
  },
} satisfies Prisma.InvestigationRunInclude;
type InvestigationRunWithContext = Prisma.InvestigationRunGetPayload<{
  include: typeof runContextInclude;
}>;
type PromptPostContext =
  | {
      platform: "LESSWRONG";
      url: string;
      authorName?: string;
      postPublishedAt?: string;
      imageUrls?: string[];
      hasVideo?: boolean;
    }
  | {
      platform: "X";
      url: string;
      authorName?: string;
      postPublishedAt?: string;
      imageUrls?: string[];
      hasVideo?: boolean;
    }
  | {
      platform: "SUBSTACK";
      url: string;
      authorName?: string;
      postPublishedAt?: string;
      imageUrls?: string[];
      hasVideo?: boolean;
    };

type UnwrappedError = Error | Record<string, unknown> | string;

function hashSnapshotText(snapshotText: string): string {
  return createHash("sha256").update(snapshotText).digest("hex");
}

function unreachablePlatform(platform: never): never {
  throw new Error(`Unsupported post platform: ${String(platform)}`);
}

function isLikelyVideoUrl(url: string): boolean {
  let pathname = url.toLowerCase();
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    // Keep best-effort behavior for malformed values already stored in metadata.
  }

  return (
    pathname.endsWith(".mp4") ||
    pathname.endsWith(".webm") ||
    pathname.endsWith(".m3u8") ||
    pathname.endsWith(".mov") ||
    pathname.endsWith(".m4v")
  );
}

function partitionXMediaUrls(mediaUrls: string[]): {
  imageUrls: string[];
  hasVideo: boolean;
} {
  const imageUrls: string[] = [];
  let hasVideo = false;

  for (const mediaUrl of mediaUrls) {
    if (isLikelyVideoUrl(mediaUrl)) {
      hasVideo = true;
      continue;
    }
    imageUrls.push(mediaUrl);
  }

  return {
    imageUrls,
    hasVideo,
  };
}

function toPromptPostContext(post: InvestigationPostContext): PromptPostContext {
  const authorName = post.author?.displayName;

  switch (post.platform) {
    case "LESSWRONG": {
      const publishedAt = post.lesswrongMeta?.publishedAt;
      return {
        platform: "LESSWRONG",
        url: post.url,
        ...(authorName != null && { authorName }),
        ...(publishedAt != null && { postPublishedAt: publishedAt.toISOString() }),
        imageUrls: post.lesswrongMeta?.imageUrls ?? [],
        hasVideo: false,
      };
    }
    case "X": {
      const postedAt = post.xMeta?.postedAt;
      const xMedia = partitionXMediaUrls(post.xMeta?.mediaUrls ?? []);
      return {
        platform: "X",
        url: post.url,
        ...(authorName != null && { authorName }),
        ...(postedAt != null && { postPublishedAt: postedAt.toISOString() }),
        imageUrls: xMedia.imageUrls,
        hasVideo: xMedia.hasVideo,
      };
    }
    case "SUBSTACK": {
      const publishedAt = post.substackMeta?.publishedAt;
      return {
        platform: "SUBSTACK",
        url: post.url,
        ...(authorName != null && { authorName }),
        ...(publishedAt != null && { postPublishedAt: publishedAt.toISOString() }),
        imageUrls: post.substackMeta?.imageUrls ?? [],
        hasVideo: false,
      };
    }
    default:
      return unreachablePlatform(post.platform);
  }
}

function toDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid ISO timestamp: ${value}`);
  }
  return parsed;
}

function toOptionalDate(value: string | null): Date | null {
  if (value === null) return null;
  return toDate(value);
}

function unwrapError(error: unknown): UnwrappedError {
  const root = error instanceof InvestigatorExecutionError
    ? (error.cause ?? error)
    : error;
  if (root instanceof Error) return root;
  if (typeof root === "object" && root !== null) {
    return root as Record<string, unknown>;
  }
  return String(root);
}

function getErrorStatus(error: unknown): number | null {
  const root = unwrapError(error);
  if (typeof root === "string") return null;
  return readOpenAiStatusCode(root);
}

function formatErrorForLog(error: unknown): string {
  const root = unwrapError(error);
  const status = getErrorStatus(root);
  if (root instanceof Error) {
    return status === null ? root.message : `status=${status}: ${root.message}`;
  }
  if (typeof root === "string") {
    return root;
  }
  return status === null ? "unknown object error" : `status=${status}`;
}

function isNonRetryableProviderError(error: unknown): boolean {
  const root = unwrapError(error);
  if (root instanceof ExpiredOpenAiKeySourceError) return true;
  if (root instanceof InvalidOpenAiKeySourceError) return true;
  if (root instanceof SyntaxError) return true;
  if (root instanceof ZodError) return true;
  if (root instanceof InvestigatorStructuredOutputError) return true;

  const status = getErrorStatus(root);
  return isNonRetryableOpenAiStatusCode(status);
}

class ActiveRunLeaseError extends Error {
  constructor(runId: string) {
    super(`Investigation run ${runId} is actively leased by another worker`);
    this.name = "ActiveRunLeaseError";
  }
}

function nextLeaseExpiry(): Date {
  return new Date(Date.now() + RUN_LEASE_TTL_MS);
}

async function tryClaimRunLease(
  runId: string,
  workerIdentity: string,
): Promise<"CLAIMED" | "MISSING" | "TERMINAL" | "LEASE_HELD"> {
  const now = new Date();
  const prisma = getPrisma();
  const claimed = await prisma.investigationRun.updateMany({
    where: {
      id: runId,
      OR: [
        {
          investigation: { is: { status: "PENDING" } },
        },
        {
          investigation: { is: { status: "PROCESSING" } },
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: now } },
          ],
        },
      ],
    },
    data: {
      leaseOwner: workerIdentity,
      leaseExpiresAt: nextLeaseExpiry(),
      startedAt: now,
      heartbeatAt: now,
    },
  });

  if (claimed.count > 0) {
    return "CLAIMED";
  }

  const run = await prisma.investigationRun.findUnique({
    where: { id: runId },
    select: {
      investigation: { select: { status: true } },
      leaseExpiresAt: true,
    },
  });

  if (!run) return "MISSING";
  if (run.investigation.status === "COMPLETE" || run.investigation.status === "FAILED") {
    return "TERMINAL";
  }
  return "LEASE_HELD";
}

async function loadClaimedRun(runId: string): Promise<InvestigationRunWithContext | null> {
  return getPrisma().investigationRun.findUnique({
    where: { id: runId },
    include: runContextInclude,
  });
}

function startRunHeartbeat(
  runId: string,
  workerIdentity: string,
  logger: Logger,
): { stop(): void } {
  const prisma = getPrisma();
  const timer = setInterval(() => {
    void prisma.investigationRun
      .updateMany({
        where: {
          id: runId,
          leaseOwner: workerIdentity,
          investigation: { is: { status: "PROCESSING" } },
        },
        data: {
          leaseExpiresAt: nextLeaseExpiry(),
          heartbeatAt: new Date(),
        },
      })
      .catch((error: unknown) => {
        logger.error(
          `Investigation run ${runId} heartbeat update failed: ${formatErrorForLog(error)}`,
        );
      });
  }, RUN_HEARTBEAT_INTERVAL_MS);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function replaceInvestigationImages(
  investigationId: string,
  imageBlobs: ImageBlob[],
): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    await tx.investigationImage.deleteMany({
      where: { investigationId },
    });

    for (const [imageOrder, imageBlob] of imageBlobs.entries()) {
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

async function resolveStoredImageDataUris(
  investigationId: string,
  candidateImageUrls: string[] | undefined,
): Promise<string[]> {
  if (!candidateImageUrls || candidateImageUrls.length === 0) {
    return [];
  }

  const storedImages = await downloadAndStoreImages(
    candidateImageUrls,
    MAX_IMAGES_PER_INVESTIGATION,
  );
  await replaceInvestigationImages(
    investigationId,
    storedImages.map((img) => img.blob),
  );
  return storedImages.map((img) => toDataUri(img.bytes, img.mimeType));
}

async function persistAttemptAudit(
  tx: Prisma.TransactionClient,
  input: {
    investigationId: string;
    attemptNumber: number;
    outcome: "SUCCEEDED" | "FAILED";
    attemptAudit: InvestigatorAttemptAudit;
  },
): Promise<void> {
  const attemptAudit = parseInvestigatorAttemptAudit(input.attemptAudit);
  if (input.outcome === "SUCCEEDED") {
    if (attemptAudit.error !== null) {
      throw new Error(
        `Attempt ${input.attemptNumber.toString()} is SUCCEEDED but contains error audit`,
      );
    }
    if (attemptAudit.response === null) {
      throw new Error(
        `Attempt ${input.attemptNumber.toString()} is SUCCEEDED but has no response audit`,
      );
    }
  } else if (attemptAudit.error === null) {
    throw new Error(
      `Attempt ${input.attemptNumber.toString()} is FAILED but has no error audit`,
    );
  }

  const attempt = await tx.investigationAttempt.upsert({
    where: {
      investigationId_attemptNumber: {
        investigationId: input.investigationId,
        attemptNumber: input.attemptNumber,
      },
    },
    create: {
      investigationId: input.investigationId,
      attemptNumber: input.attemptNumber,
      outcome: input.outcome,
      requestModel: attemptAudit.requestModel,
      requestInstructions: attemptAudit.requestInstructions,
      requestInput: attemptAudit.requestInput,
      requestReasoningEffort: attemptAudit.requestReasoningEffort,
      requestReasoningSummary: attemptAudit.requestReasoningSummary,
      responseId: attemptAudit.response?.responseId ?? null,
      responseStatus: attemptAudit.response?.responseStatus ?? null,
      responseModelVersion: attemptAudit.response?.responseModelVersion ?? null,
      responseOutputText: attemptAudit.response?.responseOutputText ?? null,
      startedAt: toDate(attemptAudit.startedAt),
      completedAt: toOptionalDate(attemptAudit.completedAt),
    },
    update: {
      outcome: input.outcome,
      requestModel: attemptAudit.requestModel,
      requestInstructions: attemptAudit.requestInstructions,
      requestInput: attemptAudit.requestInput,
      requestReasoningEffort: attemptAudit.requestReasoningEffort,
      requestReasoningSummary: attemptAudit.requestReasoningSummary,
      responseId: attemptAudit.response?.responseId ?? null,
      responseStatus: attemptAudit.response?.responseStatus ?? null,
      responseModelVersion: attemptAudit.response?.responseModelVersion ?? null,
      responseOutputText: attemptAudit.response?.responseOutputText ?? null,
      startedAt: toDate(attemptAudit.startedAt),
      completedAt: toOptionalDate(attemptAudit.completedAt),
    },
  });

  await tx.investigationAttemptRequestedTool.deleteMany({
    where: { attemptId: attempt.id },
  });
  await tx.investigationAttemptToolCall.deleteMany({
    where: { attemptId: attempt.id },
  });
  await tx.investigationAttemptOutputItem.deleteMany({
    where: { attemptId: attempt.id },
  });
  await tx.investigationAttemptUsage.deleteMany({
    where: { attemptId: attempt.id },
  });
  await tx.investigationAttemptError.deleteMany({
    where: { attemptId: attempt.id },
  });

  for (const requestedTool of attemptAudit.requestedTools) {
    await tx.investigationAttemptRequestedTool.create({
      data: {
        attemptId: attempt.id,
        requestOrder: requestedTool.requestOrder,
        toolType: requestedTool.toolType,
        rawDefinition: requestedTool.rawDefinition,
      },
    });
  }

  const outputItemIdByIndex = new Map<number, string>();
  for (const outputItem of attemptAudit.response?.outputItems ?? []) {
    const createdOutputItem = await tx.investigationAttemptOutputItem.create({
      data: {
        attemptId: attempt.id,
        outputIndex: outputItem.outputIndex,
        providerItemId: outputItem.providerItemId,
        itemType: outputItem.itemType,
        itemStatus: outputItem.itemStatus,
      },
    });
    outputItemIdByIndex.set(outputItem.outputIndex, createdOutputItem.id);
  }

  const textPartIdByKey = new Map<string, string>();
  for (const textPart of attemptAudit.response?.outputTextParts ?? []) {
    const outputItemId = outputItemIdByIndex.get(textPart.outputIndex);
    if (!outputItemId) {
      throw new Error(
        `Missing output item for text part outputIndex=${textPart.outputIndex}`,
      );
    }

    const createdTextPart = await tx.investigationAttemptOutputTextPart.create({
      data: {
        outputItemId,
        partIndex: textPart.partIndex,
        partType: textPart.partType,
        text: textPart.text,
      },
    });

    textPartIdByKey.set(
      `${textPart.outputIndex}:${textPart.partIndex}`,
      createdTextPart.id,
    );
  }

  for (const annotation of attemptAudit.response?.outputTextAnnotations ?? []) {
    const textPartId = textPartIdByKey.get(
      `${annotation.outputIndex}:${annotation.partIndex}`,
    );
    if (!textPartId) {
      throw new Error(
        `Missing text part for annotation outputIndex=${annotation.outputIndex} partIndex=${annotation.partIndex}`,
      );
    }

    await tx.investigationAttemptOutputTextAnnotation.create({
      data: {
        textPartId,
        annotationIndex: annotation.annotationIndex,
        annotationType: annotation.annotationType,
        startIndex: annotation.startIndex,
        endIndex: annotation.endIndex,
        url: annotation.url,
        title: annotation.title,
        fileId: annotation.fileId,
      },
    });
  }

  for (const summary of attemptAudit.response?.reasoningSummaries ?? []) {
    const outputItemId = outputItemIdByIndex.get(summary.outputIndex);
    if (!outputItemId) {
      throw new Error(
        `Missing output item for reasoning summary outputIndex=${summary.outputIndex}`,
      );
    }

    await tx.investigationAttemptReasoningSummary.create({
      data: {
        outputItemId,
        summaryIndex: summary.summaryIndex,
        text: summary.text,
      },
    });
  }

  for (const toolCall of attemptAudit.response?.toolCalls ?? []) {
    const outputItemId = outputItemIdByIndex.get(toolCall.outputIndex);
    if (!outputItemId) {
      throw new Error(
        `Missing output item for tool call outputIndex=${toolCall.outputIndex}`,
      );
    }

    await tx.investigationAttemptToolCall.create({
      data: {
        attemptId: attempt.id,
        outputItemId,
        outputIndex: toolCall.outputIndex,
        providerToolCallId: toolCall.providerToolCallId,
        toolType: toolCall.toolType,
        status: toolCall.status,
        rawPayload: toolCall.rawPayload,
        capturedAt: toDate(toolCall.capturedAt),
        providerStartedAt: toOptionalDate(toolCall.providerStartedAt),
        providerCompletedAt: toOptionalDate(toolCall.providerCompletedAt),
      },
    });
  }

  if (attemptAudit.response?.usage) {
    await tx.investigationAttemptUsage.create({
      data: {
        attemptId: attempt.id,
        inputTokens: attemptAudit.response.usage.inputTokens,
        outputTokens: attemptAudit.response.usage.outputTokens,
        totalTokens: attemptAudit.response.usage.totalTokens,
        cachedInputTokens: attemptAudit.response.usage.cachedInputTokens,
        reasoningOutputTokens:
          attemptAudit.response.usage.reasoningOutputTokens,
      },
    });
  }

  if (attemptAudit.error) {
    await tx.investigationAttemptError.create({
      data: {
        attemptId: attempt.id,
        errorName: attemptAudit.error.errorName,
        errorMessage: attemptAudit.error.errorMessage,
        statusCode: attemptAudit.error.statusCode,
      },
    });
  }
}

async function persistFailedAttemptAndMarkInvestigationFailed(
  input: {
    runId: string;
    investigationId: string;
    attemptNumber: number;
    attemptAudit: InvestigatorAttemptAudit | null;
  },
): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    if (input.attemptAudit) {
      await persistAttemptAudit(tx, {
        investigationId: input.investigationId,
        attemptNumber: input.attemptNumber,
        outcome: "FAILED",
        attemptAudit: input.attemptAudit,
      });
    }

    await tx.investigation.update({
      where: { id: input.investigationId },
      data: { status: "FAILED" },
    });

    await tx.investigationRun.update({
      where: { id: input.runId },
      data: {
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: new Date(),
      },
    });

    await consumeOpenAiKeySource(tx, input.runId);
  });
}

async function persistFailedAttemptAndResetInvestigationPending(
  input: {
    runId: string;
    investigationId: string;
    attemptNumber: number;
    attemptAudit: InvestigatorAttemptAudit | null;
  },
): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    if (input.attemptAudit) {
      await persistAttemptAudit(tx, {
        investigationId: input.investigationId,
        attemptNumber: input.attemptNumber,
        outcome: "FAILED",
        attemptAudit: input.attemptAudit,
      });
    }

    await tx.investigation.update({
      where: { id: input.investigationId },
      data: { status: "PENDING" },
    });

    await tx.investigationRun.update({
      where: { id: input.runId },
      data: {
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        queuedAt: new Date(),
      },
    });
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
    throw new ActiveRunLeaseError(runId);
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
    const promptPostContext = toPromptPostContext(investigation.post);
    const imageDataUris = await resolveStoredImageDataUris(
      investigation.id,
      promptPostContext.imageUrls,
    );
    const output = await investigator.investigate({
      contentText: investigation.contentText,
      ...promptPostContext,
      imageUrls: imageDataUris,
      ...(promptPostContext.hasVideo ? { hasVideo: true } : {}),
    });

    await prisma.$transaction(async (tx) => {
      await persistAttemptAudit(tx, {
        investigationId: investigation.id,
        attemptNumber: options.attemptNumber,
        outcome: "SUCCEEDED",
        attemptAudit: output.attemptAudit,
      });

      await tx.claim.deleteMany({
        where: { investigationId: investigation.id },
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

      await tx.investigation.update({
        where: { id: investigation.id },
        data: {
          status: "COMPLETE",
          checkedAt: new Date(),
          modelVersion: output.modelVersion ?? null,
        },
      });

      await tx.investigationRun.update({
        where: { id: run.id },
        data: {
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: new Date(),
        },
      });

      await consumeOpenAiKeySource(tx, run.id);
    });

    logger.info(
      `Investigation ${investigation.id} completed with ${output.result.claims.length} claims`,
    );
  } catch (error) {
    if (isRecordNotFoundError(error)) {
      logger.info(
        `Investigation ${investigation.id} disappeared during processing; skipping stale job`,
      );
      return;
    }

    const attemptAudit =
      error instanceof InvestigatorExecutionError ? error.attemptAudit : null;

    // NON_RETRYABLE: deterministic provider or parsing failures.
    if (isNonRetryableProviderError(error)) {
      logger.error(
        `Investigation ${investigation.id} failed non-retryable provider output: ${formatErrorForLog(error)}`,
      );
      await persistFailedAttemptAndMarkInvestigationFailed({
        runId: run.id,
        investigationId: investigation.id,
        attemptNumber: options.attemptNumber,
        attemptAudit,
      });
      return;
    }

    // TRANSIENT: everything else — rethrow for graphile-worker retry with backoff.
    if (options.isLastAttempt) {
      logger.error(
        `Investigation ${investigation.id} exhausted retries and is marked FAILED: ${formatErrorForLog(error)}`,
      );
      await persistFailedAttemptAndMarkInvestigationFailed({
        runId: run.id,
        investigationId: investigation.id,
        attemptNumber: options.attemptNumber,
        attemptAudit,
      });
      return;
    }

    await persistFailedAttemptAndResetInvestigationPending({
      runId: run.id,
      investigationId: investigation.id,
      attemptNumber: options.attemptNumber,
      attemptAudit,
    });

    logger.error(
      `Investigation ${investigation.id} transient failure: ${formatErrorForLog(error)}`,
    );
    throw error;
  } finally {
    heartbeat.stop();
  }
}
