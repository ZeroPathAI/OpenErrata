import { getPrisma } from "$lib/db/client";
import {
  parseInvestigatorAttemptAudit,
  type InvestigatorAttemptFailedAudit,
  type InvestigatorAttemptAudit,
  type InvestigatorAttemptSucceededAudit,
} from "$lib/investigators/interface.js";
import { toDate, toOptionalDate } from "$lib/date.js";
import type { Prisma } from "$lib/generated/prisma/client";
import { consumeOpenAiKeySource } from "./user-key-source.js";
import { nextRecoveryAfter } from "./run-lease.js";

function isFailedAttemptAudit(
  attemptAudit: InvestigatorAttemptAudit,
): attemptAudit is InvestigatorAttemptFailedAudit {
  return attemptAudit.error !== null;
}

function isSucceededAttemptAudit(
  attemptAudit: InvestigatorAttemptAudit,
): attemptAudit is InvestigatorAttemptSucceededAudit {
  return attemptAudit.error === null;
}

export async function persistAttemptAudit(
  tx: Prisma.TransactionClient,
  input: {
    investigationId: string;
    attemptNumber: number;
    outcome: "SUCCEEDED" | "FAILED";
    attemptAudit: InvestigatorAttemptAudit;
  },
): Promise<void> {
  const attemptAudit = parseInvestigatorAttemptAudit(input.attemptAudit);
  const failedAttemptAudit = isFailedAttemptAudit(attemptAudit) ? attemptAudit : null;
  const succeededAttemptAudit = isSucceededAttemptAudit(attemptAudit) ? attemptAudit : null;
  if (input.outcome === "SUCCEEDED" && failedAttemptAudit) {
    throw new Error(
      `Attempt ${input.attemptNumber.toString()} is SUCCEEDED but contains error audit`,
    );
  }
  if (input.outcome === "FAILED" && succeededAttemptAudit) {
    throw new Error(`Attempt ${input.attemptNumber.toString()} is FAILED but has no error audit`);
  }
  if (
    input.outcome === "SUCCEEDED" &&
    succeededAttemptAudit === null &&
    failedAttemptAudit === null
  ) {
    throw new Error(`Attempt ${input.attemptNumber.toString()} has invalid outcome state`);
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
      completedAt: toOptionalDate(attemptAudit.completedAt, { strict: true }),
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

export async function persistFailedAttemptAndMarkInvestigationFailed(input: {
  runId: string;
  investigationId: string;
  attemptNumber: number;
  attemptAudit: InvestigatorAttemptAudit | null;
}): Promise<boolean> {
  return getPrisma().$transaction(async (tx) => {
    // Guard: only mark FAILED if still PROCESSING. Another worker may have
    // already moved this investigation to COMPLETE or FAILED.
    const transitioned = await tx.investigation.updateMany({
      where: { id: input.investigationId, status: "PROCESSING" },
      data: { status: "FAILED" },
    });

    if (transitioned.count === 0) {
      return false;
    }

    if (input.attemptAudit) {
      await persistAttemptAudit(tx, {
        investigationId: input.investigationId,
        attemptNumber: input.attemptNumber,
        outcome: "FAILED",
        attemptAudit: input.attemptAudit,
      });
    }

    await tx.investigationRun.update({
      where: { id: input.runId },
      data: {
        leaseOwner: null,
        leaseExpiresAt: null,
        recoverAfterAt: null,
        heartbeatAt: new Date(),
      },
    });

    await consumeOpenAiKeySource(tx, input.runId);
    return true;
  });
}

export async function persistFailedAttemptAndReleaseLease(input: {
  runId: string;
  investigationId: string;
  attemptNumber: number;
  attemptAudit: InvestigatorAttemptAudit | null;
}): Promise<boolean> {
  return getPrisma().$transaction(async (tx) => {
    // Guard: only persist transient failure audit if the investigation is still
    // PROCESSING. This UPDATE also takes a row lock so terminal transitions
    // serialize cleanly with stale workers.
    const active = await tx.investigation.updateMany({
      where: { id: input.investigationId, status: "PROCESSING" },
      data: { status: "PROCESSING" },
    });
    if (active.count === 0) {
      return false;
    }

    if (input.attemptAudit) {
      await persistAttemptAudit(tx, {
        investigationId: input.investigationId,
        attemptNumber: input.attemptNumber,
        outcome: "FAILED",
        attemptAudit: input.attemptAudit,
      });
    }

    // Keep investigation PROCESSING — don't reset to PENDING.
    // Resetting to PENDING opened a window where the selector or
    // investigateNow could re-enqueue, creating duplicate graphile-worker
    // jobs via the jobKey replacement behavior.
    //
    // Release the lease for graphile-worker retry and set a recovery window:
    // selector/investigateNow should not recover this run until recoverAfterAt.
    await tx.investigationRun.update({
      where: { id: input.runId },
      data: {
        leaseOwner: null,
        leaseExpiresAt: null,
        recoverAfterAt: nextRecoveryAfter(),
      },
    });
    return true;
  });
}
