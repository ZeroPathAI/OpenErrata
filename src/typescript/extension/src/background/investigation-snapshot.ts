import type {
  ExtensionPostStatus,
  InvestigationClaim,
  InvestigationId,
  InvestigationStatusOutput,
  InvestigateNowOutput,
  ViewPostOutput,
} from "@openerrata/shared";

type UpdateInterimClaims = {
  oldClaims: InvestigationClaim[];
  sourceInvestigationId: InvestigationId;
};

export function snapshotFromInvestigateNowResult(
  result: InvestigateNowOutput,
  existing?: InvestigationStatusOutput | null,
): InvestigationStatusOutput {
  switch (result.status) {
    case "COMPLETE":
      return {
        investigationState: "INVESTIGATED",
        provenance: result.provenance,
        claims: result.claims,
      };
    case "PENDING":
    case "PROCESSING": {
      const updateFallback = readPriorInvestigationResult(existing);
      return updateFallback === null
        ? {
            investigationState: "INVESTIGATING",
            status: result.status,
            provenance: result.provenance,
            claims: null,
            priorInvestigationResult: null,
          }
        : {
            investigationState: "INVESTIGATING",
            status: result.status,
            provenance: result.provenance,
            claims: null,
            priorInvestigationResult: updateFallback,
          };
    }
    case "FAILED":
      return {
        investigationState: "FAILED",
        provenance: result.provenance,
        claims: null,
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPriorInvestigationResult(snapshot: unknown): UpdateInterimClaims | null {
  if (!isRecord(snapshot)) return null;
  if (!("priorInvestigationResult" in snapshot)) return null;
  const priorInvestigationResult = snapshot["priorInvestigationResult"];
  if (!isRecord(priorInvestigationResult)) return null;
  if (!("oldClaims" in priorInvestigationResult)) return null;
  if (!("sourceInvestigationId" in priorInvestigationResult)) return null;
  return {
    oldClaims: priorInvestigationResult["oldClaims"] as InvestigationClaim[],
    sourceInvestigationId:
      priorInvestigationResult["sourceInvestigationId"] as InvestigationId,
  };
}

export function toInvestigationStatusForCaching(
  snapshot:
    | ViewPostOutput
    | InvestigationStatusOutput
    | ExtensionPostStatus
    | null
    | undefined,
): InvestigationStatusOutput | null {
  if (snapshot === null || snapshot === undefined) {
    return null;
  }
  const priorInvestigationResult = readPriorInvestigationResult(snapshot);
  if (priorInvestigationResult === null) return null;
  if (snapshot.investigationState === "NOT_INVESTIGATED") {
    return {
      investigationState: "NOT_INVESTIGATED",
      claims: null,
      priorInvestigationResult,
    };
  }
  if (snapshot.investigationState === "INVESTIGATING") {
    return {
      investigationState: "INVESTIGATING",
      status: snapshot.status,
      provenance: snapshot.provenance,
      claims: null,
      priorInvestigationResult,
    };
  }
  return null;
}
