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
