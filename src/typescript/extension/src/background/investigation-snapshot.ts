import {
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

function readPriorInvestigationResult(snapshot: unknown): UpdateInterimClaims | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  if (!("priorInvestigationResult" in snapshot)) return null;
  const result = priorInvestigationResultSchema.safeParse(
    (snapshot as Record<string, unknown>)["priorInvestigationResult"],
  );
  return result.success ? result.data : null;
}

export function toInvestigationStatusForCaching(
  snapshot: ViewPostOutput | InvestigationStatusOutput | ExtensionPostStatus | null | undefined,
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
