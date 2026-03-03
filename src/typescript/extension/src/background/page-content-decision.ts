import type {
  ExtensionPostStatus,
  InvestigationStatusOutput,
  ViewPostOutput,
} from "@openerrata/shared";

export function decidePageContentSnapshot(input: {
  result: ViewPostOutput;
  resultUpdateInterim: InvestigationStatusOutput | null;
  existingForSession: ExtensionPostStatus | null;
  existingForSessionUpdateInterim: InvestigationStatusOutput | null;
}): { snapshot: InvestigationStatusOutput; shouldAutoInvestigate: boolean } {
  let snapshot: InvestigationStatusOutput;
  if (input.result.investigationState === "INVESTIGATED") {
    snapshot = input.result;
  } else if (input.resultUpdateInterim !== null) {
    snapshot = input.resultUpdateInterim;
  } else if (input.existingForSession?.investigationState === "INVESTIGATING") {
    if (input.existingForSessionUpdateInterim !== null) {
      snapshot = input.existingForSessionUpdateInterim;
    } else {
      snapshot = {
        investigationState: "INVESTIGATING",
        status: input.existingForSession.status,
        provenance: input.existingForSession.provenance,
        pendingClaims: input.existingForSession.pendingClaims,
        confirmedClaims: input.existingForSession.confirmedClaims,
        priorInvestigationResult: null,
      };
    }
  } else if (input.existingForSession?.investigationState === "FAILED") {
    snapshot = {
      investigationState: "FAILED",
      provenance: input.existingForSession.provenance,
    };
  } else {
    // API_ERROR and NOT_INVESTIGATED fall through to the fresh result.
    snapshot = input.result;
  }

  return {
    snapshot,
    // Auto-investigate should only run for the server's current-version miss.
    // Interim snapshots are display data and must not trigger new work.
    shouldAutoInvestigate: input.result.investigationState === "NOT_INVESTIGATED",
  };
}
