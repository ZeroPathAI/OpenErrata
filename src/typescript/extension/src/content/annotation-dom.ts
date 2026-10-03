export const ANNOTATION_CLASS = "openerrata-annotation";
export const ANNOTATION_SELECTOR = `.${ANNOTATION_CLASS}`;
export const ANNOTATION_CLAIM_ID_ATTRIBUTE = "data-openerrata-claim-id";

/** Replace each OpenErrata highlight mark under `root` by its children. */
export function unwrapAnnotationMarks(root: ParentNode): void {
  for (const mark of Array.from(root.querySelectorAll(ANNOTATION_SELECTOR))) {
    mark.replaceWith(...Array.from(mark.childNodes));
  }
}

/**
 * A detached copy of `root` without OpenErrata highlight marks. Every page
 * HTML snapshot that leaves the page must be taken from one: the extension's
 * own marks are not page content.
 */
export function cloneWithoutAnnotations(root: Element): Element {
  const clone = root.cloneNode(true);
  if (!isElementNode(clone)) {
    throw new Error("cloneNode(true) on an Element did not return an Element");
  }
  unwrapAnnotationMarks(clone);
  return clone;
}

function isElementNode(node: Node): node is Element {
  return node.nodeType === 1;
}
