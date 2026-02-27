import {
  isExcludedWikipediaSectionTitle,
  normalizeContent,
  normalizeWikipediaSectionTitle,
  shouldExcludeWikipediaElement,
} from "@openerrata/shared";
import type { AdapterExtractionResult, PlatformAdapter } from "./model";
import { extractContentWithImageOccurrencesFromRoot } from "./utils";
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

type MediaWikiWindow = Window & {
  mw?: {
    config?: {
      get?: (key: string) => unknown;
    };
  };
};

function readMwConfigValue(document: Document, key: string): unknown {
  const defaultView = document.defaultView as MediaWikiWindow | null;
  return defaultView?.mw?.config?.get?.(key);
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

  const timestampMatch = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
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
  const match = tagName.match(/^H([2-6])$/i);
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
  const clone = root.cloneNode(true) as Element;

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
