import {
  isNonNullObject,
  priorInvestigationResultSchema,
  type ExtensionPostStatus,
  type InvestigationStatusOutput,
  type InvestigateNowOutput,
  type ViewPostOutput,
} from "@openerrata/shared";

type UpdateInterimClaims = NonNullable<
  Extract<
    InvestigationStatusOutput,
    { investigationState: "NOT_INVESTIGATED" }
  >["priorInvestigationResult"]
>;

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
      return {
        investigationState: "INVESTIGATING",
        status: result.status,
        provenance: result.provenance,
        pendingClaims: [],
        confirmedClaims: [],
        priorInvestigationResult: updateFallback,
      };
    }
    case "FAILED":
      return {
        investigationState: "FAILED",
        provenance: result.provenance,
      };
  }
}

function readPriorInvestigationResult(snapshot: unknown): UpdateInterimClaims | null {
  if (!isNonNullObject(snapshot)) return null;
  if (!("priorInvestigationResult" in snapshot)) return null;
  const result = priorInvestigationResultSchema.safeParse(snapshot["priorInvestigationResult"]);
  return result.success ? result.data : null;
}

export function toInvestigationStatusForCaching(
  snapshot: ViewPostOutput | InvestigationStatusOutput | ExtensionPostStatus | null | undefined,
): InvestigationStatusOutput | null {
  if (snapshot === null || snapshot === undefined) {
    return null;
  }
  switch (snapshot.investigationState) {
    case "NOT_INVESTIGATED":
      return {
        investigationState: "NOT_INVESTIGATED",
        priorInvestigationResult: readPriorInvestigationResult(snapshot),
      };
    case "INVESTIGATING":
      return {
        investigationState: "INVESTIGATING",
        status: snapshot.status,
        provenance: snapshot.provenance,
        pendingClaims: snapshot.pendingClaims,
        confirmedClaims: snapshot.confirmedClaims,
        priorInvestigationResult: readPriorInvestigationResult(snapshot),
      };
    case "INVESTIGATED":
      return {
        investigationState: "INVESTIGATED",
        provenance: snapshot.provenance,
        claims: snapshot.claims,
      };
    case "FAILED":
      // ExtensionPostStatus FAILED has optional provenance; InvestigationStatusOutput
      // requires it. If provenance is absent, we can't construct a valid cache entry.
      if (!("provenance" in snapshot) || snapshot.provenance === undefined) {
        return null;
      }
      return {
        investigationState: "FAILED",
        provenance: snapshot.provenance,
      };
  }
}
