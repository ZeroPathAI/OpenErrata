import {
  isExcludedWikipediaSectionTitle,
  normalizeContent,
  normalizeWikipediaSectionTitle,
  shouldExcludeWikipediaElement,
} from "@openerrata/shared";
import type { AdapterExtractionResult, PlatformAdapter } from "./model";
import { cloneElement, extractContentWithImageOccurrencesFromRoot } from "./utils";
import {
  normalizeWikipediaTitleToken,
  parseWikipediaIdentity,
  wikipediaExternalIdFromPageId,
} from "../../lib/wikipedia-url.js";

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
type InlineMwConfigCacheEntry =
  | {
      found: false;
    }
  | {
      found: true;
      value: unknown;
    };
const inlineMwConfigCache = new WeakMap<Document, Map<string, InlineMwConfigCacheEntry>>();

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

function parseMwConfigValueFromScriptText(
  scriptText: string,
  key: string,
): InlineMwConfigCacheEntry {
  const escapedKey = escapeRegExp(key);

  const numberMatch = new RegExp(`"${escapedKey}"\\s*:\\s*(-?\\d+)`).exec(scriptText);
  if (numberMatch?.[1] !== undefined) {
    const numericValue = Number(numberMatch[1]);
    if (Number.isInteger(numericValue)) {
      return {
        found: true,
        value: numericValue,
      };
    }
  }

  const stringMatch = new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(
    scriptText,
  );
  if (stringMatch?.[1] !== undefined) {
    const decoded = decodeJsonStringLiteral(stringMatch[1]);
    if (decoded !== null) {
      return {
        found: true,
        value: decoded,
      };
    }
  }

  const booleanMatch = new RegExp(`"${escapedKey}"\\s*:\\s*(true|false|!0|!1)`).exec(scriptText);
  if (booleanMatch?.[1] !== undefined) {
    return {
      found: true,
      value: booleanMatch[1] === "true" || booleanMatch[1] === "!0",
    };
  }

  if (new RegExp(`"${escapedKey}"\\s*:\\s*null`).test(scriptText)) {
    return {
      found: true,
      value: null,
    };
  }

  return {
    found: false,
  };
}

function readMwConfigValueFromInlineScripts(document: Document, key: string): unknown {
  let cacheByKey = inlineMwConfigCache.get(document);
  if (cacheByKey === undefined) {
    cacheByKey = new Map<string, InlineMwConfigCacheEntry>();
    inlineMwConfigCache.set(document, cacheByKey);
  }

  const cachedEntry = cacheByKey.get(key);
  if (cachedEntry !== undefined) {
    return cachedEntry.found ? cachedEntry.value : undefined;
  }

  for (const script of document.querySelectorAll<HTMLScriptElement>("script:not([src])")) {
    const scriptText = script.text;
    if (!scriptText.includes(`"${key}"`)) {
      continue;
    }
    if (!INLINE_WIKIPEDIA_CONFIG_SCRIPT_HINTS.some((hint) => scriptText.includes(hint))) {
      continue;
    }

    const entry = parseMwConfigValueFromScriptText(scriptText, key);
    if (entry.found) {
      cacheByKey.set(key, entry);
      return entry.value;
    }
  }

  cacheByKey.set(key, {
    found: false,
  });
  return undefined;
}

function readMwConfigValue(document: Document, key: string): unknown {
  const defaultView = document.defaultView as MediaWikiWindow | null;
  const fromMwRuntime = defaultView?.mw?.config?.get?.(key);
  if (fromMwRuntime !== undefined) {
    return fromMwRuntime;
  }

  // Content scripts run in an isolated world, so page globals like `window.mw`
  // are not guaranteed to be directly readable. Fall back to inline config.
  return readMwConfigValueFromInlineScripts(document, key);
}

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

function headingLevel(tagName: string): number | null {
  const match = /^H([2-6])$/i.exec(tagName);
  if (match?.[1] === undefined || match[1].length === 0) {
    return null;
  }
  return Number(match[1]);
}

function normalizeHeadingText(heading: Element): string {
  const headline = heading.querySelector(".mw-headline");
  return normalizeWikipediaSectionTitle((headline ?? heading).textContent);
}

function removeSectionFromHeading(heading: HTMLElement): void {
  const level = headingLevel(heading.tagName);
  if (level === null) {
    heading.remove();
    return;
  }

  let cursor: Element = heading;
  while (true) {
    const nextSibling: Element | null = cursor.nextElementSibling;
    cursor.remove();

    if (!nextSibling) {
      return;
    }

    const nextLevel = headingLevel(nextSibling.tagName);
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

function metadataTitleFromConfig(document: Document): string | null {
  const pageName = readMwConfigValue(document, "wgPageName");
  if (typeof pageName !== "string") {
    return null;
  }
  return normalizeWikipediaTitleToken(pageName);
}

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

    const namespaceNumber = readMwConfigValue(document, "wgNamespaceNumber");
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

    const pageId = toIdString(readMwConfigValue(document, "wgArticleId"));
    const revisionId = toIdString(readMwConfigValue(document, "wgRevisionId"));
    if (pageId === null || pageId.length === 0 || revisionId === null || revisionId.length === 0) {
      return {
        kind: "not_ready",
        reason: "missing_identity",
      };
    }

    const metadataTitle = identity.title ?? metadataTitleFromConfig(document);
    if (metadataTitle === null || metadataTitle.length === 0) {
      return {
        kind: "not_ready",
        reason: "missing_identity",
      };
    }

    const { imageUrls, imageOccurrences } = extracted;
    const hasVideo = prunedRoot.querySelector(VIDEO_SELECTOR) !== null;
    const mediaState = hasVideo ? "has_video" : imageUrls.length > 0 ? "has_images" : "text_only";

    const lastModifiedAt = toIsoDate(readMwConfigValue(document, "wgRevisionTimestamp"));
    const displayTitle = displayTitleFromDocument(document);

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
        },
      },
    };
  },

  getContentRoot(document: Document): Element | null {
    return document.querySelector(CONTENT_ROOT_SELECTOR);
  },
};
