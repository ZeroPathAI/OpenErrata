import type { Platform, PlatformContent } from "@openerrata/shared";

export type AdapterNotReadyReason =
  | "hydrating"
  | "ambiguous_dom"
  | "unsupported"
  | "missing_identity";

export type AdapterExtractionResult =
  | {
      kind: "ready";
      content: PlatformContent;
    }
  | {
      kind: "not_ready";
      reason: AdapterNotReadyReason;
    };

export interface PlatformAdapter {
  platformKey: Platform;
  contentRootSelector: string;
  matches(url: string): boolean;
  detectFromDom?(document: Document): boolean;
  detectPrivateOrGated?(document: Document): boolean;
  extract(document: Document): AdapterExtractionResult;
  getContentRoot(document: Document): Element | null;

  /**
   * Build a per-root element exclusion filter for claim-to-DOM matching.
   * The returned predicate identifies elements whose subtrees should be
   * excluded from both text extraction and annotation rendering, keeping the
   * DOM mapper's text consistent with the server-side content that claims
   * were generated against.
   *
   * Receives the content root so it can precompute structural exclusions
   * (e.g. Wikipedia excluded sections like "References" / "External links")
   * in addition to element-level exclusions (e.g. citation superscripts).
   *
   * Returns `undefined` when no filtering is needed (non-Wikipedia adapters).
   */
  buildMatchingFilter?(root: Element): ((element: Element) => boolean) | undefined;
}

export function isLikelyVisible(element: Element): boolean {
  const defaultView = element.ownerDocument.defaultView;
  if (!defaultView || !(element instanceof defaultView.HTMLElement)) {
    return true;
  }

  if (element.hidden) {
    return false;
  }
  const style = defaultView.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  const isJsdom = defaultView.navigator.userAgent.toLowerCase().includes("jsdom");
  if (!isJsdom && element.offsetParent === null && style.position !== "fixed") {
    return false;
  }

  return true;
}
