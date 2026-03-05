import { getPrisma } from "$lib/db/client";
import {
  parseInvestigatorAttemptAudit,
  type InvestigatorAttemptAudit,
} from "$lib/investigators/interface.js";
import { toDate, toOptionalDate } from "$lib/date.js";
import type { Prisma } from "$lib/db/prisma-client";
import { consumeOpenAiKeySource } from "./user-key-source.js";

export async function persistAttemptAudit(
  tx: Prisma.TransactionClient,
  input: {
    investigationId: string;
    attemptNumber: number;
    attemptAudit: InvestigatorAttemptAudit;
  },
): Promise<void> {
  const attemptAudit = parseInvestigatorAttemptAudit(input.attemptAudit);
  // outcome is derived from the audit's discriminated union — error !== null
  // means FAILED. No separate parameter needed, no inconsistent state possible.
  const outcome = attemptAudit.error !== null ? "FAILED" : "SUCCEEDED";

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
      outcome,
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
      completedAt: toOptionalDate(attemptAudit.completedAt, { strict: true }),
    },
    update: {
      outcome,
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
      completedAt: toOptionalDate(attemptAudit.completedAt, { strict: true }),
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
    if (outputItemId === undefined || outputItemId.length === 0) {
      throw new Error(`Missing output item for text part outputIndex=${textPart.outputIndex}`);
    }

    const createdTextPart = await tx.investigationAttemptOutputTextPart.create({
      data: {
        outputItemId,
        partIndex: textPart.partIndex,
        partType: textPart.partType,
        text: textPart.text,
      },
    });

    textPartIdByKey.set(`${textPart.outputIndex}:${textPart.partIndex}`, createdTextPart.id);
  }

  for (const annotation of attemptAudit.response?.outputTextAnnotations ?? []) {
    const textPartId = textPartIdByKey.get(`${annotation.outputIndex}:${annotation.partIndex}`);
    if (textPartId === undefined || textPartId.length === 0) {
      throw new Error(
        `Missing text part for annotation outputIndex=${annotation.outputIndex} partIndex=${annotation.partIndex}`,
      );
    }

    await tx.investigationAttemptOutputTextAnnotation.create({
      data: {
        textPartId,
        annotationIndex: annotation.annotationIndex,
        annotationType: annotation.annotationType,
        startIndex: annotation.characterPosition?.start ?? null,
        endIndex: annotation.characterPosition?.end ?? null,
        url: annotation.url,
        title: annotation.title,
        fileId: annotation.fileId,
      },
    });
  }

  for (const summary of attemptAudit.response?.reasoningSummaries ?? []) {
    const outputItemId = outputItemIdByIndex.get(summary.outputIndex);
    if (outputItemId === undefined || outputItemId.length === 0) {
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
    if (outputItemId === undefined || outputItemId.length === 0) {
      throw new Error(`Missing output item for tool call outputIndex=${toolCall.outputIndex}`);
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
        providerStartedAt: toOptionalDate(toolCall.providerStartedAt, { strict: true }),
        providerCompletedAt: toOptionalDate(toolCall.providerCompletedAt, { strict: true }),
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
        reasoningOutputTokens: attemptAudit.response.usage.reasoningOutputTokens,
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

/**
 * Inner transaction body for marking an investigation FAILED.
 * Exported for unit-testability — callers outside this module should use
 * `persistFailedAttemptAndMarkInvestigationFailed` instead.
 */
export async function markInvestigationFailedInTx(
  tx: Prisma.TransactionClient,
  input: {
    investigationId: string;
    workerIdentity: string;
    attemptNumber: number;
    attemptAudit: InvestigatorAttemptAudit | null;
  },
): Promise<boolean> {
  // Guard: delete the lease row matching our workerIdentity. If it doesn't
  // exist (another worker reclaimed or investigation already terminal),
  // we bail out without modifying Investigation status.
  const released = await tx.investigationLease.deleteMany({
    where: {
      investigationId: input.investigationId,
      leaseOwner: input.workerIdentity,
    },
  });

  if (released.count === 0) {
    return false;
  }

  const transitioned = await tx.investigation.updateMany({
    where: { id: input.investigationId, status: "PROCESSING" },
    data: { status: "FAILED" },
  });

  if (transitioned.count === 0) {
    throw new Error(
      `Invariant violation: lease existed for investigation ${input.investigationId} but status was not PROCESSING`,
    );
  }

  if (input.attemptAudit) {
    await persistAttemptAudit(tx, {
      investigationId: input.investigationId,
      attemptNumber: input.attemptNumber,
      attemptAudit: input.attemptAudit,
    });
  }

  await consumeOpenAiKeySource(tx, input.investigationId);
  return true;
}

export async function persistFailedAttemptAndMarkInvestigationFailed(input: {
  investigationId: string;
  workerIdentity: string;
  attemptNumber: number;
  attemptAudit: InvestigatorAttemptAudit | null;
}): Promise<boolean> {
  return getPrisma().$transaction((tx) => markInvestigationFailedInTx(tx, input));
}

/**
 * Inner transaction body for releasing the lease and reclaiming PROCESSING → PENDING.
 * Exported for unit-testability — callers outside this module should use
 * `persistFailedAttemptAndReleaseLease` instead.
 */
export async function releaseLeaseToRetryInTx(
  tx: Prisma.TransactionClient,
  input: {
    investigationId: string;
    workerIdentity: string;
    attemptNumber: number;
    attemptAudit: InvestigatorAttemptAudit | null;
    retryAfter: Date;
  },
): Promise<boolean> {
  // Guard: delete the lease row matching our workerIdentity.
  const released = await tx.investigationLease.deleteMany({
    where: {
      investigationId: input.investigationId,
      leaseOwner: input.workerIdentity,
    },
  });

  if (released.count === 0) {
    return false;
  }

  const transitioned = await tx.investigation.updateMany({
    where: { id: input.investigationId, status: "PROCESSING" },
    data: { status: "PENDING", queuedAt: new Date(), retryAfter: input.retryAfter },
  });

  if (transitioned.count === 0) {
    throw new Error(
      `Invariant violation: lease existed for investigation ${input.investigationId} but status was not PROCESSING`,
    );
  }

  if (input.attemptAudit) {
    await persistAttemptAudit(tx, {
      investigationId: input.investigationId,
      attemptNumber: input.attemptNumber,
      attemptAudit: input.attemptAudit,
    });
  }

  return true;
}

/**
 * Atomic reclaim: PROCESSING → PENDING with lease deleted.
 *
 * The caller must explicitly re-enqueue via `enqueueInvestigation(investigationId)`
 * after this returns true. The per-investigation jobKey
 * (`investigate:${investigationId}`) ensures that concurrent enqueue calls from
 * the re-enqueue, the selector, or investigateNow all resolve to exactly one
 * graphile-worker job via replacement semantics.
 */
export async function persistFailedAttemptAndReleaseLease(input: {
  investigationId: string;
  workerIdentity: string;
  attemptNumber: number;
  attemptAudit: InvestigatorAttemptAudit | null;
  retryAfter: Date;
}): Promise<boolean> {
  return getPrisma().$transaction((tx) => releaseLeaseToRetryInTx(tx, input));
}
