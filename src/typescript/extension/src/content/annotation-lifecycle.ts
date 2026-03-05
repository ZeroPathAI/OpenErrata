import type { InvestigationClaim, ViewPostOutput } from "@openerrata/shared";
import type { ParsedExtensionPageStatus } from "./sync";

export function areClaimsEqual(left: InvestigationClaim[], right: InvestigationClaim[]): boolean {
  if (left.length !== right.length) return false;

  for (const [index, leftClaim] of left.entries()) {
    const rightClaim = right[index];
    if (!rightClaim) return false;

    if (
      leftClaim.id !== rightClaim.id ||
      leftClaim.text !== rightClaim.text ||
      leftClaim.summary !== rightClaim.summary ||
      leftClaim.context !== rightClaim.context ||
      leftClaim.reasoning !== rightClaim.reasoning ||
      leftClaim.sources.length !== rightClaim.sources.length
    ) {
      return false;
    }

    for (const [sourceIndex, leftSource] of leftClaim.sources.entries()) {
      const rightSource = rightClaim.sources[sourceIndex];
      if (!rightSource) return false;
      if (
        leftSource.url !== rightSource.url ||
        leftSource.title !== rightSource.title ||
        leftSource.snippet !== rightSource.snippet
      ) {
        return false;
      }
    }
  }

  return true;
}

export function extractDisplayClaimsFromViewPost(viewPost: ViewPostOutput): InvestigationClaim[] {
  if (viewPost.investigationState === "INVESTIGATED") {
    return viewPost.claims;
  }
  if (viewPost.priorInvestigationResult !== null) {
    return viewPost.priorInvestigationResult.oldClaims;
  }
  return [];
}

export function extractDisplayClaimsFromStatus(
  status: ParsedExtensionPageStatus,
): InvestigationClaim[] | null {
  if (status.kind !== "POST") return null;
  if (status.investigationState === "INVESTIGATED") {
    return status.claims;
  }
  if (
    (status.investigationState === "INVESTIGATING" ||
      status.investigationState === "NOT_INVESTIGATED") &&
    status.priorInvestigationResult !== null
  ) {
    return status.priorInvestigationResult.oldClaims;
  }
  return null;
}
