export const ANNOTATION_CLASS = "openerrata-annotation";
export const ANNOTATION_SELECTOR = `.${ANNOTATION_CLASS}`;
export const ANNOTATION_CLAIM_ID_ATTRIBUTE = "data-openerrata-claim-id";

export function readAnnotationClaimId(element: Element): string | null {
  return element.getAttribute(ANNOTATION_CLAIM_ID_ATTRIBUTE);
}
