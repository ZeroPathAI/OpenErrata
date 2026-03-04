import {
  effectiveHeadingLevel,
  effectiveHeadingText,
  headingLevelFromTag,
  isExcludedWikipediaSectionTitle,
  normalizeContent,
  normalizeWikipediaSectionTitle,
  shouldExcludeWikipediaElement,
  utf8ByteLength,
  type WikipediaNodeDescriptor,
} from "@openerrata/shared";
import type { AdapterExtractionResult, PlatformAdapter } from "./model";
import { cloneElement, extractContentWithImageOccurrencesFromRoot } from "./utils";
import {
  normalizeWikipediaTitleToken,
  parseWikipediaIdentity,
  wikipediaExternalIdFromPageId,
} from "../../lib/wikipedia-url.js";

// The comma-selector "#mw-content-text .mw-parser-output, #mw-content-text" cannot be
// used with querySelector() for content root selection: querySelector returns the first
// match in document order, and parent elements precede their descendants, so
// #mw-content-text always wins over its descendant .mw-parser-output. We use the
// comma-selector only for detection (contentRootSelector / detectFromDom), where we
// just need to know if either element exists. getContentRoot() uses two separate queries
// with an explicit fallback so .mw-parser-output is preferred.
//
// Preferring .mw-parser-output matters because the Wikipedia Parse API returns only the
// article body (.mw-parser-output equivalent), not the surrounding #mw-content-text which
// also contains tracking pixels, printfooter, and other non-article elements. Scoping
// client extraction to .mw-parser-output keeps it consistent with the server's source.
const CONTENT_ROOT_SELECTOR = "#mw-content-text .mw-parser-output, #mw-content-text";
const HEADING_SELECTOR = "h2, h3, h4, h5, h6";
const VIDEO_SELECTOR = [
  "video",
  "audio",
  "source[type^='video/']",
  "source[type^='audio/']",
  ".mw-tmh-player",
  ".mw-tmh-play",
].join(",");
const INLINE_WIKIPEDIA_CONFIG_SCRIPT_HINTS = ["RLCONF", "mw.config.set"] as const;

/** Maximum serialized HTML size (UTF-8 bytes) for client-side HTML transport. */
const WIKIPEDIA_HTML_CONTENT_MAX_BYTES = 256 * 1024;

/**
 * Convert pruned Wikipedia HTML to a transportable string, or undefined if
 * the serialized HTML exceeds the byte-size cap.
 *
 * Unlike Substack's serializeContentHtml, no annotation stripping is needed
 * here: pruneWikipediaContent already operates on a cloneElement() detached
 * from the live DOM, so OpenErrata annotations are never present.
 */
function toTransportableHtmlContent(prunedRoot: Element): string | undefined {
  const html = prunedRoot.innerHTML;
  if (html.length === 0) {
    return undefined;
  }
  return utf8ByteLength(html) <= WIKIPEDIA_HTML_CONTENT_MAX_BYTES ? html : undefined;
}

// ── MediaWiki config reading ──────────────────────────────────────────────
//
// Wikipedia pages embed article metadata (page ID, revision ID, timestamps)
// in inline <script> tags via mw.config.set / RLCONF. In the main world,
// these are accessible via `window.mw.config.get(key)`, but content scripts
// run in an isolated world where page globals are not directly readable.
//
// To avoid scanning all <script> tags once per key (5 keys × ~10 scripts),
// readMwConfig() collects every needed value in a single pass through the
// DOM. The result is a plain object scoped to the extract() call — no
// module-level state that could go stale across SPA navigations.

/** The set of MediaWiki config keys that extract() needs. */
const MW_CONFIG_KEYS = [
  "wgNamespaceNumber",
  "wgArticleId",
  "wgRevisionId",
  "wgRevisionTimestamp",
  "wgPageName",
] as const;

type MwConfigKey = (typeof MW_CONFIG_KEYS)[number];
type MwConfig = Record<MwConfigKey, unknown>;

type MediaWikiWindow = Window & {
  mw?: {
    config?: {
      get?: (key: string) => unknown;
    };
  };
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeJsonStringLiteral(value: string): string | null {
  try {
    const decoded = JSON.parse(`"${value}"`) as unknown;
    return typeof decoded === "string" ? decoded : null;
  } catch {
    return null;
  }
}

function parseMwConfigValueFromScriptText(scriptText: string, key: string): unknown {
  const escapedKey = escapeRegExp(key);

  const numberMatch = new RegExp(`"${escapedKey}"\\s*:\\s*(-?\\d+)`).exec(scriptText);
  if (numberMatch?.[1] !== undefined) {
    const numericValue = Number(numberMatch[1]);
    if (Number.isInteger(numericValue)) {
      return numericValue;
    }
  }

  const stringMatch = new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(
    scriptText,
  );
  if (stringMatch?.[1] !== undefined) {
    const decoded = decodeJsonStringLiteral(stringMatch[1]);
    if (decoded !== null) {
      return decoded;
    }
  }

  const booleanMatch = new RegExp(`"${escapedKey}"\\s*:\\s*(true|false|!0|!1)`).exec(scriptText);
  if (booleanMatch?.[1] !== undefined) {
    return booleanMatch[1] === "true" || booleanMatch[1] === "!0";
  }

  if (new RegExp(`"${escapedKey}"\\s*:\\s*null`).test(scriptText)) {
    return null;
  }

  return undefined;
}

/**
 * Read all needed MediaWiki config values in a single pass. Tries
 * `window.mw.config.get()` first (main-world access), then falls back to
 * regex parsing of inline `<script>` tags.
 *
 * Returns a plain object scoped to this call — no module-level cache.
 */
function readMwConfig(document: Document): MwConfig {
  const config: MwConfig = {
    wgNamespaceNumber: undefined,
    wgArticleId: undefined,
    wgRevisionId: undefined,
    wgRevisionTimestamp: undefined,
    wgPageName: undefined,
  };

  // Try the runtime mw.config API first (works when page globals are
  // accessible, e.g. in the main world or JSDOM tests with globalSetup).
  const defaultView = document.defaultView as MediaWikiWindow | null;
  const mwConfigGet = defaultView?.mw?.config?.get;
  if (mwConfigGet !== undefined) {
    let allFound = true;
    for (const key of MW_CONFIG_KEYS) {
      const value = mwConfigGet(key);
      if (value !== undefined) {
        config[key] = value;
      } else {
        allFound = false;
      }
    }
    if (allFound) {
      return config;
    }
  }

  // Fall back to inline script parsing for keys not found via mw.config.
  // Collect the keys still missing so we can stop early once all are found.
  const missing = new Set<MwConfigKey>(MW_CONFIG_KEYS.filter((key) => config[key] === undefined));

  for (const script of document.querySelectorAll<HTMLScriptElement>("script:not([src])")) {
    if (missing.size === 0) break;

    const scriptText = script.text;
    if (!INLINE_WIKIPEDIA_CONFIG_SCRIPT_HINTS.some((hint) => scriptText.includes(hint))) {
      continue;
    }

    for (const key of missing) {
      if (!scriptText.includes(`"${key}"`)) {
        continue;
      }
      const value = parseMwConfigValueFromScriptText(scriptText, key);
      if (value !== undefined) {
        config[key] = value;
        missing.delete(key);
      }
    }
  }

  return config;
}

// ── DOM helpers ───────────────────────────────────────────────────────────

function toIdString(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value.toString();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return value;
  }
  return null;
}

function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const timestampMatch = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (timestampMatch) {
    const [, year, month, day, hour, minute, second] = timestampMatch;
    const iso = new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      ),
    );
    if (!Number.isNaN(iso.valueOf())) {
      return iso.toISOString();
    }
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function firstDirectChildHeadingElement(element: Element): Element | null {
  for (const child of element.children) {
    if (headingLevelFromTag(child.tagName) !== null) {
      return child;
    }
  }
  return null;
}

/** Build a WikipediaNodeDescriptor from a DOM Element for shared heading logic. */
function toNodeDescriptor(element: Element): WikipediaNodeDescriptor {
  const firstHeading = firstDirectChildHeadingElement(element);
  return {
    tagName: element.tagName,
    classTokens: Array.from(element.classList),
    textContent: element.textContent,
    firstChildHeading:
      firstHeading !== null
        ? { tagName: firstHeading.tagName, textContent: firstHeading.textContent }
        : null,
  };
}

function normalizeHeadingText(heading: Element): string {
  const headline = heading.querySelector(".mw-headline");
  const descriptor = toNodeDescriptor(heading);
  return normalizeWikipediaSectionTitle(
    effectiveHeadingText(descriptor, (headline ?? heading).textContent),
  );
}

function removeSectionFromHeading(heading: HTMLElement): void {
  const level = headingLevelFromTag(heading.tagName);
  if (level === null) {
    heading.remove();
    return;
  }

  // Parsoid HTML wraps headings in `<div class="mw-heading mw-headingN">`.
  // Starting removal from the wrapper div (rather than the inner <h2>) ensures
  // that cursor.nextElementSibling is the actual section content — in the
  // new format, all section content is a sibling of the wrapper, not of the
  // heading element inside it.
  const parent = heading.parentElement;
  const parentLevel = parent !== null ? effectiveHeadingLevel(toNodeDescriptor(parent)) : null;
  const startCursor: Element = parent !== null && parentLevel !== null ? parent : heading;

  let cursor: Element = startCursor;
  while (true) {
    const nextSibling: Element | null = cursor.nextElementSibling;
    cursor.remove();

    if (!nextSibling) {
      return;
    }

    const nextLevel = effectiveHeadingLevel(toNodeDescriptor(nextSibling));
    if (nextLevel !== null && nextLevel <= level) {
      return;
    }

    cursor = nextSibling;
  }
}

function pruneWikipediaContent(root: Element): Element {
  const clone = cloneElement(root);

  for (const node of clone.querySelectorAll<HTMLElement>("*")) {
    if (
      shouldExcludeWikipediaElement({
        tagName: node.tagName,
        classTokens: Array.from(node.classList),
      })
    ) {
      node.remove();
    }
  }

  for (const heading of clone.querySelectorAll<HTMLElement>(HEADING_SELECTOR)) {
    const headingText = normalizeHeadingText(heading);
    if (isExcludedWikipediaSectionTitle(headingText)) {
      removeSectionFromHeading(heading);
    }
  }

  return clone;
}

function displayTitleFromDocument(document: Document): string | undefined {
  const headingText = normalizeContent(document.querySelector("#firstHeading")?.textContent ?? "");
  return headingText.length > 0 ? headingText : undefined;
}

function metadataTitleFromMwConfig(mwConfig: MwConfig): string | null {
  const pageName = mwConfig.wgPageName;
  if (typeof pageName !== "string") {
    return null;
  }
  return normalizeWikipediaTitleToken(pageName);
}

// ── Adapter ───────────────────────────────────────────────────────────────

export const wikipediaAdapter: PlatformAdapter = {
  platformKey: "WIKIPEDIA",
  contentRootSelector: CONTENT_ROOT_SELECTOR,

  matches(url: string): boolean {
    return parseWikipediaIdentity(url) !== null;
  },

  detectFromDom(document: Document): boolean {
    return document.querySelector(CONTENT_ROOT_SELECTOR) !== null;
  },

  extract(document: Document): AdapterExtractionResult {
    const identity = parseWikipediaIdentity(document.location.href);
    if (!identity) {
      return {
        kind: "not_ready",
        reason: "missing_identity",
      };
    }

    // Read all MediaWiki config values in one pass — no module-level cache.
    const mwConfig = readMwConfig(document);

    const namespaceNumber = mwConfig.wgNamespaceNumber;
    if (typeof namespaceNumber === "number" && namespaceNumber !== 0) {
      return {
        kind: "not_ready",
        reason: "unsupported",
      };
    }

    const contentRoot = this.getContentRoot(document);
    if (!contentRoot) {
      return {
        kind: "not_ready",
        reason: "hydrating",
      };
    }

    const prunedRoot = pruneWikipediaContent(contentRoot);
    const extracted = extractContentWithImageOccurrencesFromRoot(
      prunedRoot,
      document.location.href,
    );
    if (extracted.contentText.length === 0) {
      return {
        kind: "not_ready",
        reason: "unsupported",
      };
    }

    const pageId = toIdString(mwConfig.wgArticleId);
    const revisionId = toIdString(mwConfig.wgRevisionId);
    if (pageId === null || pageId.length === 0 || revisionId === null || revisionId.length === 0) {
      return {
        kind: "not_ready",
        reason: "missing_identity",
      };
    }

    const metadataTitle = identity.title ?? metadataTitleFromMwConfig(mwConfig);
    if (metadataTitle === null || metadataTitle.length === 0) {
      return {
        kind: "not_ready",
        reason: "missing_identity",
      };
    }

    const { imageUrls, imageOccurrences } = extracted;
    const hasVideo = prunedRoot.querySelector(VIDEO_SELECTOR) !== null;
    const mediaState = hasVideo ? "has_video" : imageUrls.length > 0 ? "has_images" : "text_only";

    const lastModifiedAt = toIsoDate(mwConfig.wgRevisionTimestamp);
    const displayTitle = displayTitleFromDocument(document);
    const htmlContent = toTransportableHtmlContent(prunedRoot);

    return {
      kind: "ready",
      content: {
        platform: "WIKIPEDIA",
        externalId: wikipediaExternalIdFromPageId(identity.language, pageId),
        url: document.location.href,
        contentText: extracted.contentText,
        mediaState,
        imageUrls,
        imageOccurrences,
        metadata: {
          language: identity.language,
          title: metadataTitle,
          pageId,
          revisionId,
          ...(displayTitle === undefined ? {} : { displayTitle }),
          ...(lastModifiedAt === null || lastModifiedAt.length === 0 ? {} : { lastModifiedAt }),
          ...(htmlContent === undefined ? {} : { htmlContent }),
        },
      },
    };
  },

  buildMatchingFilter(root: Element): (element: Element) => boolean {
    // Precompute the set of direct-child elements within excluded sections
    // (e.g. "References", "External links"). An excluded section starts at a
    // heading whose title matches isExcludedWikipediaSectionTitle and extends
    // to the next sibling heading of equal or higher level — mirroring the
    // section removal logic in pruneWikipediaContent / removeSectionFromHeading.
    const excludedSectionElements = new Set<Element>();

    for (const child of root.children) {
      const descriptor = toNodeDescriptor(child);
      const level = effectiveHeadingLevel(descriptor);
      if (level === null) continue;

      const headingText = normalizeHeadingText(child);
      if (!isExcludedWikipediaSectionTitle(headingText)) continue;

      excludedSectionElements.add(child);
      let sibling = child.nextElementSibling;
      while (sibling) {
        const siblingLevel = effectiveHeadingLevel(toNodeDescriptor(sibling));
        if (siblingLevel !== null && siblingLevel <= level) break;
        excludedSectionElements.add(sibling);
        sibling = sibling.nextElementSibling;
      }
    }

    return (element: Element): boolean => {
      // Element-level exclusion (citations, edit sections, navboxes, etc.)
      if (
        shouldExcludeWikipediaElement({
          tagName: element.tagName,
          classTokens: Array.from(element.classList),
        })
      ) {
        return true;
      }
      // Section-level exclusion — the TreeWalker's FILTER_REJECT skips
      // subtrees, so checking direct membership is sufficient.
      return excludedSectionElements.has(element);
    };
  },

  getContentRoot(document: Document): Element | null {
    return (
      document.querySelector("#mw-content-text .mw-parser-output") ??
      document.querySelector("#mw-content-text")
    );
  },
};
