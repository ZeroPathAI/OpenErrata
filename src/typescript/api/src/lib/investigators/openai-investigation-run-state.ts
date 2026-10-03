import type { InvestigationResult } from "@openerrata/shared";
import type { InvestigatorInput } from "./interface.js";
import type { ClaimValidationResult } from "./openai-claim-validator.js";

type StageOneClaim = InvestigationResult["claims"][number];
type OldClaim = Extract<InvestigatorInput, { isUpdate: true }>["oldClaims"][number];

export interface PendingValidationEntry {
  claim: StageOneClaim;
  claimIndex: number;
  submissionOrder: number;
  promise: Promise<ClaimValidationResult>;
  settled: boolean;
}

interface ConfirmedClaimEntry {
  claim: StageOneClaim;
  submissionOrder: number;
}

export interface InvestigationRunState {
  nextClaimIndex: number;
  nextSubmissionOrder: number;
  pendingValidations: readonly PendingValidationEntry[];
  confirmedClaims: readonly ConfirmedClaimEntry[];
  oldClaimsById: ReadonlyMap<string, OldClaim>;
  retainedIds: ReadonlySet<string>;
}

type RetainOldClaimResult =
  | {
      kind: "ok";
      nextState: InvestigationRunState;
      claim: StageOneClaim;
    }
  | {
      kind: "error";
      reason: "unknown_id" | "already_retained";
    };

export function createInvestigationRunState(input: {
  oldClaims?: readonly OldClaim[];
}): InvestigationRunState {
  const oldClaimsById = new Map<string, OldClaim>();
  for (const claim of input.oldClaims ?? []) {
    oldClaimsById.set(claim.id, claim);
  }

  return {
    nextClaimIndex: 0,
    nextSubmissionOrder: 0,
    pendingValidations: [],
    confirmedClaims: [],
    oldClaimsById,
    retainedIds: new Set<string>(),
  };
}

export function enqueuePendingValidation(
  state: InvestigationRunState,
  input: {
    claim: StageOneClaim;
    promise: Promise<ClaimValidationResult>;
  },
): {
  nextState: InvestigationRunState;
  claimIndex: number;
  pendingIndex: number;
} {
  const pendingIndex = state.pendingValidations.length;
  const claimIndex = state.nextClaimIndex;
  const submissionOrder = state.nextSubmissionOrder;
  const pendingEntry: PendingValidationEntry = {
    claim: input.claim,
    claimIndex,
    submissionOrder,
    promise: input.promise,
    settled: false,
  };

  return {
    claimIndex,
    pendingIndex,
    nextState: {
      ...state,
      nextClaimIndex: state.nextClaimIndex + 1,
      nextSubmissionOrder: state.nextSubmissionOrder + 1,
      pendingValidations: [...state.pendingValidations, pendingEntry],
    },
  };
}

export function settlePendingValidation(
  state: InvestigationRunState,
  input: {
    pendingIndex: number;
    result: ClaimValidationResult;
  },
): InvestigationRunState {
  const pending = state.pendingValidations[input.pendingIndex];
  if (pending === undefined) {
    throw new Error(`Pending validation index out of bounds: ${input.pendingIndex.toString()}`);
  }

  if (pending.settled) {
    throw new Error(`Pending validation already settled: ${input.pendingIndex.toString()}`);
  }

  const pendingValidations = state.pendingValidations.map((entry, index) =>
    index === input.pendingIndex ? { ...entry, settled: true } : entry,
  );

  const confirmedClaims =
    input.result.kind === "approved"
      ? [
          ...state.confirmedClaims,
          {
            claim: pending.claim,
            submissionOrder: pending.submissionOrder,
          },
        ]
      : state.confirmedClaims;

  return {
    ...state,
    pendingValidations,
    confirmedClaims,
  };
}

export function retainOldClaim(
  state: InvestigationRunState,
  claimId: string,
): RetainOldClaimResult {
  const oldClaim = state.oldClaimsById.get(claimId);
  if (oldClaim === undefined) {
    return {
      kind: "error",
      reason: "unknown_id",
    };
  }

  if (state.retainedIds.has(claimId)) {
    return {
      kind: "error",
      reason: "already_retained",
    };
  }

  const retainedIds = new Set(state.retainedIds);
  retainedIds.add(claimId);

  const { id: _claimId, ...claim } = oldClaim;

  return {
    kind: "ok",
    claim,
    nextState: {
      ...state,
      nextSubmissionOrder: state.nextSubmissionOrder + 1,
      confirmedClaims: [
        ...state.confirmedClaims,
        {
          claim,
          submissionOrder: state.nextSubmissionOrder,
        },
      ],
      retainedIds,
    },
  };
}

export function getPendingClaims(state: InvestigationRunState): StageOneClaim[] {
  return state.pendingValidations.filter((entry) => !entry.settled).map((entry) => entry.claim);
}

export function getConfirmedClaims(state: InvestigationRunState): StageOneClaim[] {
  return [...state.confirmedClaims]
    .sort((left, right) => left.submissionOrder - right.submissionOrder)
    .map((entry) => entry.claim);
}

export function getPendingValidationPromises(
  state: InvestigationRunState,
): Promise<ClaimValidationResult>[] {
  return state.pendingValidations.map((entry) => entry.promise);
}
