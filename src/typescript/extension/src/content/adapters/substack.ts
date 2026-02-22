import type { PlatformContent } from "@openerrata/shared";
import { normalizeContent } from "@openerrata/shared";
import type { PlatformAdapter } from "./lesswrong";

const CONTENT_SELECTOR = ".body.markup";
const TITLE_SELECTOR = "h1.post-title";
const SUBTITLE_SELECTOR = "h3.subtitle, h2.subtitle";
const AUTHOR_META_SELECTOR = 'meta[name="author"]';
const JSON_LD_SELECTOR = 'script[type="application/ld+json"]';
const SUBSTACK_FINGERPRINT_SELECTOR = [
  'link[href*="substackcdn.com"]',
  'script[src*="substackcdn.com"]',
  'img[src*="substackcdn.com"]',
  'meta[property="og:url"][content*=".substack.com"]',
  'meta[name="twitter:image"][content*="post_preview/"]',
].join(",");
const SUBSTACK_POST_PATH_REGEX = /^\/p\/([^/?#]+)/i;
const SUBSTACK_HOST_REGEX = /(^|\.)substack\.com$/i;
const SUBSTACK_POST_PREVIEW_ID_REGEX = /post_preview\/(\d+)\/(?:twitter|facebook)\.(?:jpg|png)/i;
const SUBSTACK_PUBLICATION_REGEX = /([a-z0-9-]+)\.substack\.com/i;

function parseIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
  return parsed.toISOString();
}

function extractImageUrls(root: Element): string[] {
  const uniqueUrls = new Set<string>();
  const images = Array.from(root.querySelectorAll<HTMLImageElement>("img[src]"));

  for (const image of images) {
    const src = image.getAttribute("src")?.trim() ?? "";
    if (src.length === 0 || src.startsWith("data:")) continue;

    try {
      uniqueUrls.add(new URL(src, window.location.href).toString());
    } catch {
      // Ignore malformed URLs; keep extraction best-effort.
    }
  }

  return Array.from(uniqueUrls);
}

function decodeCandidates(raw: string): string[] {
  const candidates = new Set<string>();
  candidates.add(raw);

  let decoded = raw;
  for (let i = 0; i < 2; i += 1) {
    try {
      decoded = decodeURIComponent(decoded);
      candidates.add(decoded);
    } catch {
      break;
    }
  }

  return Array.from(candidates);
}

function extractSubstackPostId(value: string): string | null {
  for (const candidate of decodeCandidates(value)) {
    const match = candidate.match(SUBSTACK_POST_PREVIEW_ID_REGEX);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function extractPublicationSubdomainFromValue(value: string): string | null {
  for (const candidate of decodeCandidates(value)) {
    const match = candidate.match(SUBSTACK_PUBLICATION_REGEX);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }
  }

  return null;
}

function extractMetaImageCandidates(document: Document): string[] {
  const selectors = [
    'meta[property="twitter:image"]',
    'meta[name="twitter:image"]',
    'meta[property="og:image"]',
    'meta[name="og:image"]',
  ];

  const candidates: string[] = [];
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.getAttribute("content")?.trim();
    if (value) {
      candidates.push(value);
    }
  }

  return candidates;
}

function findPublishedDateInJsonLd(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findPublishedDateInJsonLd(nested, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const datePublished = record["datePublished"];
  if (typeof datePublished === "string") {
    const iso = parseIsoDate(datePublished);
    if (iso) return iso;
  }

  for (const nested of Object.values(record)) {
    const found = findPublishedDateInJsonLd(nested, depth + 1);
    if (found) return found;
  }

  return null;
}

function extractPublishedAt(document: Document): string | null {
  const timeValue = document.querySelector("time[datetime]")?.getAttribute("datetime");
  const fromTime = parseIsoDate(timeValue);
  if (fromTime) return fromTime;

  const metaSelectors = [
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
    'meta[property="og:article:published_time"]',
  ];

  for (const selector of metaSelectors) {
    const value = document.querySelector(selector)?.getAttribute("content");
    const iso = parseIsoDate(value);
    if (iso) return iso;
  }

  for (const script of document.querySelectorAll<HTMLScriptElement>(JSON_LD_SELECTOR)) {
    const text = script.textContent.trim();
    if (!text) continue;

    try {
      const parsed = JSON.parse(text) as unknown;
      const publishedAt = findPublishedDateInJsonLd(parsed);
      if (publishedAt) return publishedAt;
    } catch {
      // Ignore malformed JSON-LD payloads.
    }
  }

  return null;
}

function extractInteractionCounts(document: Document): {
  likeCount?: number;
  commentCount?: number;
} {
  const state: {
    likeCount?: number;
    commentCount?: number;
  } = {};

  const visit = (node: unknown, depth = 0): void => {
    if (depth > 10 || node === null || node === undefined) return;

    if (Array.isArray(node)) {
      for (const nested of node) {
        visit(nested, depth + 1);
      }
      return;
    }

    if (typeof node !== "object") return;

    const record = node as Record<string, unknown>;
    const interactionStatistic = record["interactionStatistic"];
    if (interactionStatistic !== undefined) {
      visit(interactionStatistic, depth + 1);
    }

    const interactionType = record["interactionType"];
    const userInteractionCount = record["userInteractionCount"];
    if (typeof userInteractionCount === "number") {
      const typeName =
        typeof interactionType === "string"
          ? interactionType
          : typeof interactionType === "object" &&
              interactionType !== null &&
              "@type" in interactionType &&
              typeof (interactionType as { "@type": unknown })["@type"] ===
                "string"
            ? String((interactionType as { "@type": unknown })["@type"])
            : "";

      if (/likeaction/i.test(typeName)) {
        state.likeCount = userInteractionCount;
      }
      if (/commentaction/i.test(typeName)) {
        state.commentCount = userInteractionCount;
      }
    }

    for (const nested of Object.values(record)) {
      visit(nested, depth + 1);
    }
  };

  for (const script of document.querySelectorAll<HTMLScriptElement>(JSON_LD_SELECTOR)) {
    const text = script.textContent.trim();
    if (!text) continue;

    try {
      visit(JSON.parse(text) as unknown);
    } catch {
      // Ignore malformed JSON-LD payloads.
    }
  }

  return state;
}

function extractAuthorHandle(document: Document): string | undefined {
  const raw =
    document
      .querySelector('meta[name="twitter:site"]')
      ?.getAttribute("content")
      ?.trim() ?? "";
  const normalized = raw.replace(/^@/, "").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseSlug(url: URL): string | null {
  const match = url.pathname.match(SUBSTACK_POST_PATH_REGEX);
  if (!match?.[1]) return null;
  const slug = normalizeContent(match[1]);
  return slug.length > 0 ? slug : null;
}

function parsePublicationSubdomain(url: URL, imageCandidates: string[]): string | null {
  if (SUBSTACK_HOST_REGEX.test(url.hostname) && url.hostname.includes(".")) {
    const parts = url.hostname.toLowerCase().split(".");
    const publicationSubdomain = parts.length >= 3 ? parts[parts.length - 3] : null;
    if (publicationSubdomain && publicationSubdomain !== "www") {
      return publicationSubdomain;
    }
  }

  for (const candidate of imageCandidates) {
    const publicationSubdomain = extractPublicationSubdomainFromValue(candidate);
    if (publicationSubdomain) return publicationSubdomain;
  }

  return null;
}

function parseSubstackPostId(imageCandidates: string[]): string | null {
  for (const candidate of imageCandidates) {
    const postId = extractSubstackPostId(candidate);
    if (postId) return postId;
  }

  return null;
}

function hasSubstackHost(url: URL): boolean {
  return SUBSTACK_HOST_REGEX.test(url.hostname) && url.hostname !== "substack.com";
}

function hasSubstackPostPath(pathname: string): boolean {
  return SUBSTACK_POST_PATH_REGEX.test(pathname);
}

export const substackAdapter: PlatformAdapter = {
  platformKey: "SUBSTACK",

  matches(url: string): boolean {
    try {
      const parsed = new URL(url);
      return hasSubstackHost(parsed) && hasSubstackPostPath(parsed.pathname);
    } catch {
      return false;
    }
  },

  detectFromDom(document: Document): boolean {
    try {
      const parsed = new URL(document.location.href);
      if (!hasSubstackPostPath(parsed.pathname)) {
        return false;
      }
    } catch {
      return false;
    }

    return document.querySelector(SUBSTACK_FINGERPRINT_SELECTOR) !== null;
  },

  extract(document: Document): PlatformContent | null {
    const root = document.querySelector(CONTENT_SELECTOR);
    if (!root) return null;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(window.location.href);
    } catch {
      return null;
    }

    const slug = parseSlug(parsedUrl);
    if (!slug) return null;

    const title = normalizeContent(
      document.querySelector(TITLE_SELECTOR)?.textContent ?? document.title,
    );
    if (title.length === 0) return null;

    const authorName = normalizeContent(
      document.querySelector(AUTHOR_META_SELECTOR)?.getAttribute("content") ?? "",
    );
    if (authorName.length === 0) return null;

    const imageCandidates = extractMetaImageCandidates(document);
    const substackPostId = parseSubstackPostId(imageCandidates);
    if (!substackPostId) return null;

    const publicationSubdomain = parsePublicationSubdomain(parsedUrl, imageCandidates);
    if (!publicationSubdomain) return null;

    const contentText = normalizeContent(root.textContent);

    const subtitle = normalizeContent(
      document.querySelector(SUBTITLE_SELECTOR)?.textContent ?? "",
    );
    const publishedAt = extractPublishedAt(document);
    const interactionCounts = extractInteractionCounts(document);
    const authorSubstackHandle = extractAuthorHandle(document);

    const imageUrls = extractImageUrls(root);
    const hasVideo = root.querySelector("video, iframe") !== null;
    const mediaState =
      imageUrls.length > 0
        ? "has_images"
        : hasVideo
          ? "video_only"
          : "text_only";

    return {
      platform: "SUBSTACK",
      externalId: substackPostId,
      url: window.location.href,
      contentText,
      mediaState,
      imageUrls,
      metadata: {
        substackPostId,
        publicationSubdomain,
        slug,
        title,
        authorName,
        ...(subtitle.length === 0 ? {} : { subtitle }),
        ...(authorSubstackHandle === undefined
          ? {}
          : { authorSubstackHandle }),
        ...(publishedAt === null ? {} : { publishedAt }),
        ...(interactionCounts.likeCount === undefined
          ? {}
          : { likeCount: interactionCounts.likeCount }),
        ...(interactionCounts.commentCount === undefined
          ? {}
          : { commentCount: interactionCounts.commentCount }),
      },
    };
  },

  getContentRoot(document: Document): Element | null {
    return document.querySelector(CONTENT_SELECTOR);
  },
};
