import { getPrisma } from "$lib/db/client";
import type {
  InvestigatorAttemptAudit,
  InvestigatorFailedAttemptAudit,
  InvestigatorOutputItemAudit,
  InvestigatorRequestAudit,
  InvestigatorResponseAudit,
} from "$lib/investigators/interface.js";
import type { Prisma } from "$lib/db/prisma-client";
import { consumeOpenAiKeySource } from "./user-key-source.js";

function toOutputItemCreate(
  item: InvestigatorOutputItemAudit,
  outputIndex: number,
): Prisma.InvestigationAttemptOutputItemCreateWithoutResponseInput {
  const base = {
    outputIndex,
    providerItemId: item.providerItemId,
    itemType: item.itemType,
    itemStatus: item.itemStatus,
  };
  switch (item.content.kind) {
    case "MESSAGE":
      return {
        ...base,
        textParts: {
          create: item.content.textParts.map((part, partIndex) => ({
            partIndex,
            partType: part.partType,
            text: part.text,
            annotations: {
              create: part.annotations.map((annotation, annotationIndex) => ({
                annotationIndex,
                ...annotation,
              })),
            },
          })),
        },
      };
    case "REASONING":
      return {
        ...base,
        reasoningSummaries: {
          create: item.content.summaries.map((text, summaryIndex) => ({ summaryIndex, text })),
        },
      };
    case "TOOL_CALL":
      return { ...base, toolCall: { create: { rawPayload: item.content.rawPayload } } };
  }
}

function toResponseCreate(
  response: InvestigatorResponseAudit,
): Prisma.InvestigationAttemptResponseCreateWithoutRequestInput {
  return {
    providerResponseId: response.providerResponseId,
    status: response.status,
    modelVersion: response.modelVersion,
    receivedAt: response.receivedAt,
    outputItems: { create: response.outputItems.map(toOutputItemCreate) },
    ...(response.usage === null ? {} : { usage: { create: response.usage } }),
  };
}

function toRequestCreate(
  request: InvestigatorRequestAudit,
): Prisma.InvestigationAttemptRequestCreateWithoutAttemptInput {
  return {
    kind: request.subject.kind,
    factCheckRound: request.subject.kind === "FACT_CHECK_ROUND" ? request.subject.round : null,
    claimIndex: request.subject.kind === "CLAIM_VALIDATION" ? request.subject.claimIndex : null,
    model: request.model,
    instructions: request.instructions,
    input: request.input,
    previousResponseId: request.previousResponseId,
    reasoningEffort: request.reasoningEffort,
    reasoningSummary: request.reasoningSummary,
    include: request.include,
    requestedTools: {
      create: request.tools.map((tool, requestOrder) => ({
        requestOrder,
        toolType: tool.toolType,
        rawDefinition: tool.rawDefinition,
      })),
    },
    ...(request.response === null
      ? {}
      : { response: { create: toResponseCreate(request.response) } }),
  };
}

/**
 * Inserts an attempt's audit (SPEC §2.12). Insert-only: each attemptNumber is
 * claimed once per investigation and its audit is written once, at the
 * attempt's terminal transition.
 */
export async function persistAttemptAudit(
  tx: Prisma.TransactionClient,
  input: {
    investigationId: string;
    attemptNumber: number;
    attemptAudit: InvestigatorAttemptAudit;
  },
): Promise<void> {
  const { attemptAudit } = input;
  await tx.investigationAttempt.create({
    data: {
      investigationId: input.investigationId,
      attemptNumber: input.attemptNumber,
      outcome: attemptAudit.outcome,
      startedAt: attemptAudit.startedAt,
      completedAt: attemptAudit.completedAt,
      requests: { create: attemptAudit.requests.map(toRequestCreate) },
      ...(attemptAudit.outcome === "FAILED" ? { error: { create: attemptAudit.error } } : {}),
    },
    select: { id: true },
  });
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
    attemptAudit: InvestigatorFailedAttemptAudit | null;
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
  attemptAudit: InvestigatorFailedAttemptAudit | null;
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
    attemptAudit: InvestigatorFailedAttemptAudit | null;
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
  attemptAudit: InvestigatorFailedAttemptAudit | null;
  retryAfter: Date;
}): Promise<boolean> {
  return getPrisma().$transaction((tx) => releaseLeaseToRetryInTx(tx, input));
}
