import type { ExtensionPageStatus, InvestigationClaimPayload } from "@openerrata/shared";

type PostStatus = Extract<ExtensionPageStatus, { kind: "POST" }>;
type InvestigatedPostStatus = Extract<PostStatus, { investigationState: "INVESTIGATED" }>;
export type PopupClaim = InvestigatedPostStatus["claims"][number];

export type PostPopupView =
  | { kind: "found_claims"; claims: PopupClaim[] }
  | { kind: "clean" }
  | { kind: "failed" }
  | {
      kind: "investigating";
      pendingClaims: InvestigationClaimPayload[];
      confirmedClaims: InvestigationClaimPayload[];
    }
  | { kind: "not_investigated"; canRequest: boolean };

export function computePostView(matched: PostStatus, canRequest: boolean): PostPopupView {
  if (matched.investigationState === "INVESTIGATED" && matched.claims.length > 0) {
    return { kind: "found_claims", claims: matched.claims };
  }
  if (matched.investigationState === "INVESTIGATED") {
    return { kind: "clean" };
  }
  if (matched.investigationState === "FAILED" || matched.investigationState === "API_ERROR") {
    return { kind: "failed" };
  }
  if (matched.investigationState === "INVESTIGATING") {
    return {
      kind: "investigating",
      pendingClaims: matched.pendingClaims,
      confirmedClaims: matched.confirmedClaims,
    };
  }
  return { kind: "not_investigated", canRequest };
}
