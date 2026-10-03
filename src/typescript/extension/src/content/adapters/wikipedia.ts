import {
  effectiveHeadingLevel,
  effectiveHeadingText,
  headingLevelFromTag,
  isExcludedWikipediaSectionTitle,
  normalizeContent,
  normalizeWikipediaSectionTitle,
  normalizeWikipediaTitleToken,
  shouldExcludeWikipediaElement,
  wikipediaExternalIdFromPageId,
  wikipediaExternalIdSchema,
  type WikipediaNodeDescriptor,
} from "@openerrata/shared";
import { pageLocatorFor, type PageLocator } from "../../lib/page-locator";
import type { AdapterExtractionResult, PlatformAdapter } from "./model";
import { extractContent, serializeContentHtml, toTransportableHtml } from "./utils";

// Prefer `.mw-parser-output`: the Wikipedia Parse API (the API's canonical
// source) returns only the article body, not the surrounding
// `#mw-content-text`, which also holds tracking pixels, the print footer and
// other non-article elements.
const CONTENT_ROOT_SELECTORS = ["#mw-content-text .mw-parser-output", "#mw-content-text"] as const;
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

function isExcludedWikipediaElement(element: Element): boolean {
  return shouldExcludeWikipediaElement({
    tagName: element.tagName,
    classTokens: Array.from(element.classList),
    role: element.getAttribute("role"),
  });
}

/** `textContent` without the text of excluded descendants (e.g. "[edit]" links in headings). */
function contentTextOf(element: Element): string {
  let text = "";
  for (const child of element.childNodes) {
    if (isTextNode(child)) {
      text += child.data;
    } else if (isElementNode(child) && !isExcludedWikipediaElement(child)) {
      text += contentTextOf(child);
    }
  }
  return text;
}

function isTextNode(node: Node): node is Text {
  return node.nodeType === 3;
}

function isElementNode(node: Node): node is Element {
  return node.nodeType === 1;
}

/** Build a WikipediaNodeDescriptor from a DOM Element for shared heading logic. */
function toNodeDescriptor(element: Element): WikipediaNodeDescriptor {
  const firstHeading = firstDirectChildHeadingElement(element);
  return {
    tagName: element.tagName,
    classTokens: Array.from(element.classList),
    textContent: contentTextOf(element),
    firstChildHeading:
      firstHeading !== null
        ? { tagName: firstHeading.tagName, textContent: contentTextOf(firstHeading) }
        : null,
  };
}

function normalizeHeadingText(heading: Element): string {
  const headline = heading.querySelector(".mw-headline");
  return normalizeWikipediaSectionTitle(
    effectiveHeadingText(toNodeDescriptor(heading), contentTextOf(headline ?? heading)),
  );
}

/**
 * The elements making up the section a heading opens: the heading (or its
 * Parsoid `div.mw-heading` wrapper — section content is a sibling of the
 * wrapper, not of the inner heading) and every following sibling up to the
 * next heading of the same or a higher level.
 */
function sectionElements(heading: Element): Element[] {
  const level = headingLevelFromTag(heading.tagName);
  if (level === null) {
    return [heading];
  }

  const parent = heading.parentElement;
  const parentLevel = parent !== null ? effectiveHeadingLevel(toNodeDescriptor(parent)) : null;
  const start: Element = parent !== null && parentLevel !== null ? parent : heading;

  const elements = [start];
  for (
    let sibling = start.nextElementSibling;
    sibling !== null;
    sibling = sibling.nextElementSibling
  ) {
    const siblingLevel = effectiveHeadingLevel(toNodeDescriptor(sibling));
    if (siblingLevel !== null && siblingLevel <= level) break;
    elements.push(sibling);
  }
  return elements;
}

function isWithinExcludedElement(element: Element, root: Element): boolean {
  for (
    let cursor: Element | null = element;
    cursor !== null && cursor !== root;
    cursor = cursor.parentElement
  ) {
    if (isExcludedWikipediaElement(cursor)) return true;
  }
  return false;
}

/**
 * Wikipedia's non-article content under `root`: excluded elements (citation
 * superscripts, edit links, navboxes, JS-injected UI — see
 * `shouldExcludeWikipediaElement`) and whole excluded sections (References,
 * External links, ...). Mirrors the API's canonical Parse-API filtering
 * (`createWikipediaNodeFilter`) so client and server text agree.
 */
function wikipediaExclusionFilter(root: Element): (element: Element) => boolean {
  const excludedSectionElements = new Set<Element>();
  for (const heading of root.querySelectorAll(HEADING_SELECTOR)) {
    if (isWithinExcludedElement(heading, root)) continue;
    if (!isExcludedWikipediaSectionTitle(normalizeHeadingText(heading))) continue;
    for (const element of sectionElements(heading)) {
      excludedSectionElements.add(element);
    }
  }

  return (element: Element): boolean =>
    isExcludedWikipediaElement(element) || excludedSectionElements.has(element);
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

type WikipediaLocator = Extract<PageLocator, { platform: "WIKIPEDIA" }>;

function wikipediaLocator(url: string): WikipediaLocator | null {
  const locator = pageLocatorFor("WIKIPEDIA", url);
  return locator?.platform === "WIKIPEDIA" ? locator : null;
}

// ── Adapter ───────────────────────────────────────────────────────────────

export const wikipediaAdapter: PlatformAdapter = {
  platformKey: "WIKIPEDIA",

  matches(url: string): boolean {
    return wikipediaLocator(url) !== null;
  },

  pageLocator(url: string): PageLocator | null {
    return wikipediaLocator(url);
  },

  extract(document: Document): AdapterExtractionResult {
    const locator = wikipediaLocator(document.location.href);
    if (locator === null) {
      return {
        kind: "not_ready",
        reason: "missing_identity",
      };
    }
    const { article } = locator;

    // Read all MediaWiki config values in one pass — no module-level cache.
    const mwConfig = readMwConfig(document);

    // wgNamespaceNumber is authoritative: URL parsing only knows canonical
    // namespace names, not localized ones (e.g. German "Diskussion:").
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

    const extracted = extractContent(contentRoot, {
      exclude: wikipediaExclusionFilter(contentRoot),
      imageSelector: "img[src]",
      baseUrl: document.location.href,
    });
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

    const metadataTitle = article.title ?? metadataTitleFromMwConfig(mwConfig);
    if (metadataTitle === null || metadataTitle.length === 0) {
      return {
        kind: "not_ready",
        reason: "missing_identity",
      };
    }

    // Video is detected on the live root, not through the content exclusions:
    // TimedMediaHandler wraps <video> in `.mw-tmh-player` (excluded as
    // non-text UI), so excluding first would miss any video whose player had
    // initialised before extraction.
    const hasVideo = contentRoot.querySelector(VIDEO_SELECTOR) !== null;
    const lastModifiedAt = toIsoDate(mwConfig.wgRevisionTimestamp);
    const displayTitle = displayTitleFromDocument(document);
    const htmlContent = toTransportableHtml(
      serializeContentHtml(contentRoot, wikipediaExclusionFilter),
      WIKIPEDIA_HTML_CONTENT_MAX_BYTES,
    );

    return {
      kind: "ready",
      content: {
        platform: "WIKIPEDIA",
        externalId: wikipediaExternalIdSchema.parse(
          wikipediaExternalIdFromPageId(article.language, pageId),
        ),
        url: document.location.href,
        contentText: extracted.contentText,
        hasVideo,
        imageOccurrences: extracted.imageOccurrences,
        metadata: {
          language: article.language,
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

  getContentRoot(document: Document): Element | null {
    for (const selector of CONTENT_ROOT_SELECTORS) {
      const root = document.querySelector(selector);
      if (root !== null) return root;
    }
    return null;
  },

  contentExclusionFilter: wikipediaExclusionFilter,
};
