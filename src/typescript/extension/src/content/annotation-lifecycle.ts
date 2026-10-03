import type { ExtensionPostStatus, InvestigationClaim } from "@openerrata/shared";

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

/**
 * Claims to highlight for a post status: the investigation's own claims once
 * it is complete; while the current version is not (yet) investigated, the
 * claims the API carried forward from another version because the text they
 * correct is still on the page (spec §2.8 "Interim carry-forward"); nothing
 * when there is no usable result.
 */
export function displayClaimsForStatus(status: ExtensionPostStatus): InvestigationClaim[] {
  switch (status.investigationState) {
    case "INVESTIGATED":
      return status.claims;
    case "INVESTIGATING":
    case "NOT_INVESTIGATED":
      return status.priorInvestigationResult?.oldClaims ?? [];
    case "FAILED":
    case "API_ERROR":
      return [];
  }
}
