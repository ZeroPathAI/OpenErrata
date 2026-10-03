import type { Platform, PlatformContent } from "@openerrata/shared";
import type { PageLocator } from "../../lib/page-locator.js";

/**
 * Why an adapter cannot produce content for the current page (spec §3.8):
 *
 * - `hydrating` / `ambiguous_dom` / `missing_identity` are transient: the page
 *   may still be rendering. The content script keeps re-checking and reports
 *   `unsupported_content` only after a grace period.
 * - `unsupported` is final for the current DOM: the page is the platform's but
 *   holds nothing the extension can check (e.g. a non-article namespace).
 */
export type AdapterNotReadyReason =
  | "hydrating"
  | "ambiguous_dom"
  | "missing_identity"
  | "unsupported";

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
  /** URL-first platform selection (spec §3.8). */
  matches(url: string): boolean;
  /** DOM-fingerprint fallback for platform pages on custom domains. */
  detectFromDom?(document: Document): boolean;
  /** What the URL alone says about which post the page shows, or null if it cannot be one. */
  pageLocator(url: string): PageLocator | null;
  detectPrivateOrGated?(document: Document): boolean;
  extract(document: Document): AdapterExtractionResult;
  /**
   * The element whose text is the post's content text — where claims are
   * located and highlighted — or null while it is not in the DOM.
   */
  getContentRoot(document: Document): Element | null;
  /**
   * Elements under `root` whose subtrees are not post content on this
   * platform (beyond `NON_CONTENT_TAGS`, which are always excluded). One
   * predicate serves text extraction, claim matching and HTML snapshots, so
   * they agree with each other and with the API's canonical text.
   */
  contentExclusionFilter(root: Element): (element: Element) => boolean;
}

/** No platform-specific exclusions. */
export function excludeNothing(): (element: Element) => boolean {
  return () => false;
}

/** Whether `element` is rendered (not `display: none` / `visibility: hidden` / `hidden`). */
export function isLikelyVisible(element: Element): boolean {
  return element.checkVisibility({ visibilityProperty: true });
}
