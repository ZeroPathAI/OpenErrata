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
import type { ClaimValidationResult } from "./openai-claim-validator.js";

type StageOneClaim = InvestigationResult["claims"][number];

type ValidationLimiter = (
  task: () => Promise<ClaimValidationResult>,
) => Promise<ClaimValidationResult>;

type ValidationRunner = (
  claimIndex: number,
  claim: StageOneClaim,
) => Promise<ClaimValidationResult>;

type RetainClaimResult =
  | {
      kind: "ok";
    }
  | {
      kind: "error";
      errorMessage: string;
    };

interface ClaimValidationScheduler {
  getState: () => InvestigationRunState;
  scheduleClaimValidation: (claim: StageOneClaim) => void;
  retainClaimById: (claimId: string) => RetainClaimResult;
  /** Every scheduled validation's result, in scheduling order, once all have settled. */
  awaitAllValidations: () => Promise<ClaimValidationResult[]>;
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

  const settleValidation = (pendingIndex: number, result: ClaimValidationResult): void => {
    state = settlePendingValidation(state, {
      pendingIndex,
      result,
    });
    emitProgressUpdate();
  };

  const scheduleClaimValidation = (claim: StageOneClaim): void => {
    const claimIndex = state.nextClaimIndex;
    // runValidation reports failures as results, never as rejections.
    const promise = input.validationLimiter(() => input.runValidation(claimIndex, claim));

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
  };
}
