import type { InvestigationResult } from "@openerrata/shared";
import type { InvestigationProgressCallbacks } from "./interface.js";
import {
  enqueuePendingValidation,
  getConfirmedClaims,
  getPendingClaims,
  getPendingValidationPromises,
  retainOldClaim,
  settlePendingValidation,
  type InvestigationRunState,
} from "./openai-investigation-run-state.js";
import type { PerClaimValidationResult } from "./openai-claim-validator.js";

type StageOneClaim = InvestigationResult["claims"][number];

type ValidationLimiter = (
  task: () => Promise<PerClaimValidationResult>,
) => Promise<PerClaimValidationResult>;

type ValidationRunner = (
  claimIndex: number,
  claim: StageOneClaim,
) => Promise<PerClaimValidationResult>;

type RetainClaimResult =
  | {
      kind: "ok";
    }
  | {
      kind: "error";
      errorMessage: string;
    };

export interface ClaimValidationScheduler {
  getState: () => InvestigationRunState;
  scheduleClaimValidation: (claim: StageOneClaim) => void;
  retainClaimById: (claimId: string) => RetainClaimResult;
  awaitAllValidations: () => Promise<PerClaimValidationResult[]>;
  settleAllValidations: () => Promise<void>;
}

function toValidationErrorResult(claimIndex: number, error: unknown): PerClaimValidationResult {
  return {
    claimIndex,
    approved: false,
    responseAudit: null,
    error: error instanceof Error ? error : new Error(String(error)),
  };
}

export function createClaimValidationScheduler(input: {
  initialState: InvestigationRunState;
  validationLimiter: ValidationLimiter;
  runValidation: ValidationRunner;
  callbacks?: InvestigationProgressCallbacks;
}): ClaimValidationScheduler {
  let state = input.initialState;

  const emitProgressUpdate = (): void => {
    input.callbacks?.onProgressUpdate(getPendingClaims(state), getConfirmedClaims(state));
  };

  const settleValidation = (pendingIndex: number, result: PerClaimValidationResult): void => {
    state = settlePendingValidation(state, {
      pendingIndex,
      result,
    });
    emitProgressUpdate();
  };

  const scheduleClaimValidation = (claim: StageOneClaim): void => {
    const claimIndex = state.nextClaimIndex;
    const promise = input
      .validationLimiter(() => input.runValidation(claimIndex, claim))
      .catch((error: unknown) => toValidationErrorResult(claimIndex, error));

    const queued = enqueuePendingValidation(state, {
      claim,
      promise,
    });
    state = queued.nextState;

    void promise.then((result) => {
      settleValidation(queued.pendingIndex, result);
    });

    emitProgressUpdate();
  };

  const retainClaimById = (claimId: string): RetainClaimResult => {
    const retained = retainOldClaim(state, claimId);
    if (retained.kind === "error") {
      return {
        kind: "error",
        errorMessage:
          retained.reason === "unknown_id"
            ? `Unknown claim ID: ${claimId}`
            : `Claim ${claimId} already retained`,
      };
    }

    state = retained.nextState;
    emitProgressUpdate();
    return { kind: "ok" };
  };

  return {
    getState: () => state,
    scheduleClaimValidation,
    retainClaimById,
    awaitAllValidations: async () => Promise.all(getPendingValidationPromises(state)),
    settleAllValidations: async () => {
      await Promise.allSettled(getPendingValidationPromises(state));
    },
  };
}
