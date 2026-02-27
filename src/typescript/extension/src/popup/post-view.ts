import type { ExtensionPageStatus } from "@openerrata/shared";

type PostStatus = Extract<ExtensionPageStatus, { kind: "POST" }>;
export type PopupClaim = NonNullable<PostStatus["claims"]>[number];

export type PostPopupView =
  | { kind: "found_claims"; claims: PopupClaim[] }
  | { kind: "clean" }
  | { kind: "failed" }
  | { kind: "content_mismatch" }
  | { kind: "investigating" }
  | { kind: "not_investigated"; canRequest: boolean };

export function computePostView(matched: PostStatus, canRequest: boolean): PostPopupView {
  if (matched.investigationState === "INVESTIGATED" && matched.claims.length > 0) {
    return { kind: "found_claims", claims: matched.claims };
  }
  if (matched.investigationState === "INVESTIGATED") {
    return { kind: "clean" };
  }
  if (matched.investigationState === "FAILED") {
    return { kind: "failed" };
  }
  if (matched.investigationState === "CONTENT_MISMATCH") {
    return { kind: "content_mismatch" };
  }
  if (matched.investigationState === "INVESTIGATING") {
    return { kind: "investigating" };
  }
  return { kind: "not_investigated", canRequest };
}
