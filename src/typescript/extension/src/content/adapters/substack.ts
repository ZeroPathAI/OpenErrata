import { normalizeContent, isNonNullObject } from "@openerrata/shared";
import type { AdapterExtractionResult, PlatformAdapter } from "./model";
import {
  extractContentWithImageOccurrencesFromRoot,
  readFirstMetaDateAsIso,
  readFirstTimeDateAsIso,
  readPublishedDateFromJsonLd,
} from "./utils";

const CONTENT_SELECTOR = ".body.markup";
const TITLE_SELECTOR = "h1.post-title";
const SUBTITLE_SELECTOR = "h3.subtitle, h2.subtitle";
const AUTHOR_META_SELECTOR = 'meta[name="author"]';
const JSON_LD_SELECTOR = 'script[type="application/ld+json"]';
const META_DATE_SELECTORS = [
  'meta[property="article:published_time"]',
  'meta[name="article:published_time"]',
  'meta[property="og:article:published_time"]',
] as const;
const JSON_LD_DATE_KEYS = new Set(["datePublished"]);
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
const PRIVATE_OR_GATED_SELECTOR = [
  '[class*="paywall"]',
  '[id*="paywall"]',
  '[data-testid*="paywall"]',
  '[class*="subscriber-only"]',
  '[id*="subscriber-only"]',
  '[class*="subscription-required"]',
  '[id*="subscription-required"]',
].join(",");
const PRIVATE_OR_GATED_PATTERNS = [
  /subscribe to continue reading/i,
  /this post is for paid subscribers/i,
  /become a paid subscriber/i,
  /already a paid subscriber/i,
  /subscriber-only post/i,
] as const;
const ACCESS_CONTROL_TERMS = ["paywall", "subscriber", "subscription"] as const;

function isHiddenElement(element: Element): boolean {
  return element.closest('[hidden], [aria-hidden="true"]') !== null;
}

function hasPrivatePattern(text: string): boolean {
  return PRIVATE_OR_GATED_PATTERNS.some((pattern) => pattern.test(text));
}

function hasAccessControlMarker(element: Element): boolean {
  const className = element.getAttribute("class")?.toLowerCase() ?? "";
  const id = element.getAttribute("id")?.toLowerCase() ?? "";
  const testId = element.getAttribute("data-testid")?.toLowerCase() ?? "";
  return ACCESS_CONTROL_TERMS.some(
    (token) => className.includes(token) || id.includes(token) || testId.includes(token),
  );
}

function hasSubscribeCta(element: Element): boolean {
  if (element.querySelector('a[href*="/subscribe"], a[href*="subscribe"]') !== null) {
    return true;
  }

  const ctaButtons = element.querySelectorAll("button, [role='button']");
  for (const button of ctaButtons) {
    const text = normalizeContent(button.textContent).toLowerCase();
    if (text.includes("subscribe")) {
      return true;
    }
  }

  return false;
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
    const match = SUBSTACK_POST_PREVIEW_ID_REGEX.exec(candidate);
    if (match?.[1] !== undefined && match[1].length > 0) {
      return match[1];
    }
  }

  return null;
}

function extractPublicationSubdomainFromValue(value: string): string | null {
  for (const candidate of decodeCandidates(value)) {
    const match = SUBSTACK_PUBLICATION_REGEX.exec(candidate);
    if (match?.[1] !== undefined && match[1].length > 0) {
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
    if (value !== undefined && value.length > 0) {
      candidates.push(value);
    }
  }

  return candidates;
}

function extractPublishedAt(document: Document, contentRoot: Element): string | null {
  const articleScope = contentRoot.closest("article") ?? contentRoot;
  return (
    readFirstMetaDateAsIso(document, META_DATE_SELECTORS) ??
    readPublishedDateFromJsonLd(document, JSON_LD_DATE_KEYS) ??
    readFirstTimeDateAsIso([articleScope, document])
  );
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

    if (!isNonNullObject(node)) return;

    const interactionStatistic = node["interactionStatistic"];
    if (interactionStatistic !== undefined) {
      visit(interactionStatistic, depth + 1);
    }

    const interactionType = node["interactionType"];
    const userInteractionCount = node["userInteractionCount"];
    if (typeof userInteractionCount === "number") {
      const typeName =
        typeof interactionType === "string"
          ? interactionType
          : isNonNullObject(interactionType) && typeof interactionType["@type"] === "string"
            ? interactionType["@type"]
            : "";

      if (/likeaction/i.test(typeName)) {
        state.likeCount = userInteractionCount;
      }
      if (/commentaction/i.test(typeName)) {
        state.commentCount = userInteractionCount;
      }
    }

    for (const nested of Object.values(node)) {
      visit(nested, depth + 1);
    }
  };

  for (const script of document.querySelectorAll<HTMLScriptElement>(JSON_LD_SELECTOR)) {
    const text = script.textContent.trim();
    if (text.length === 0) continue;

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
    document.querySelector('meta[name="twitter:site"]')?.getAttribute("content")?.trim() ?? "";
  const normalized = raw.replace(/^@/, "").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseSlug(url: URL): string | null {
  const match = SUBSTACK_POST_PATH_REGEX.exec(url.pathname);
  if (match?.[1] === undefined || match[1].length === 0) return null;
  const slug = normalizeContent(match[1]);
  return slug.length > 0 ? slug : null;
}

function parsePublicationSubdomain(url: URL, imageCandidates: string[]): string | null {
  if (SUBSTACK_HOST_REGEX.test(url.hostname) && url.hostname.includes(".")) {
    const parts = url.hostname.toLowerCase().split(".");
    const publicationSubdomainCandidate = parts.length >= 3 ? parts[parts.length - 3] : undefined;
    if (
      publicationSubdomainCandidate !== undefined &&
      publicationSubdomainCandidate.length > 0 &&
      publicationSubdomainCandidate !== "www"
    )
      return publicationSubdomainCandidate;
  }

  for (const candidate of imageCandidates) {
    const publicationSubdomain = extractPublicationSubdomainFromValue(candidate);
    if (publicationSubdomain !== null && publicationSubdomain.length > 0)
      return publicationSubdomain;
  }

  return null;
}

function parseSubstackPostId(imageCandidates: string[]): string | null {
  for (const candidate of imageCandidates) {
    const postId = extractSubstackPostId(candidate);
    if (postId !== null && postId.length > 0) return postId;
  }

  return null;
}

function hasSubstackHost(url: URL): boolean {
  return SUBSTACK_HOST_REGEX.test(url.hostname) && url.hostname !== "substack.com";
}

function hasSubstackPostPath(pathname: string): boolean {
  return SUBSTACK_POST_PATH_REGEX.test(pathname);
}

function hasPrivateOrGatedMarkers(document: Document): boolean {
  const explicitMarkers = document.querySelectorAll(PRIVATE_OR_GATED_SELECTOR);
  for (const marker of explicitMarkers) {
    if (isHiddenElement(marker)) continue;
    const text = normalizeContent(marker.textContent);
    if (text.length === 0) continue;
    if (hasPrivatePattern(text)) {
      return true;
    }
  }

  const contentRoot = document.querySelector(CONTENT_SELECTOR);
  const hasExtractablePostContent =
    contentRoot !== null && normalizeContent(contentRoot.textContent).length > 0;

  const candidateRoots = new Set<Element>();
  const main = document.querySelector("main");
  const article = document.querySelector("article");
  if (main) candidateRoots.add(main);
  if (article) candidateRoots.add(article);
  if (!hasExtractablePostContent) {
    candidateRoots.add(document.body);
  }

  for (const root of candidateRoots) {
    const candidateBlocks = root.querySelectorAll("section, article, div, aside, p");
    for (const block of candidateBlocks) {
      if (isHiddenElement(block)) continue;
      const text = normalizeContent(block.textContent);
      if (text.length === 0) continue;
      if (!hasPrivatePattern(text)) continue;

      const hasAccessMarker = hasAccessControlMarker(block);
      const hasCta = hasSubscribeCta(block);
      if (hasAccessMarker && hasCta) {
        return true;
      }

      if (!hasExtractablePostContent && (hasAccessMarker || hasCta)) {
        return true;
      }
    }
  }

  return false;
}

export const substackAdapter: PlatformAdapter = {
  platformKey: "SUBSTACK",
  contentRootSelector: CONTENT_SELECTOR,

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

  detectPrivateOrGated(document: Document): boolean {
    return hasPrivateOrGatedMarkers(document);
  },

  extract(document: Document): AdapterExtractionResult {
    const url = window.location.href;
    const root = document.querySelector(CONTENT_SELECTOR);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return {
        kind: "not_ready",
        reason: "missing_identity",
      };
    }

    const slug = parseSlug(parsedUrl);
    if (slug === null || slug.length === 0) {
      return {
        kind: "not_ready",
        reason: "missing_identity",
      };
    }

    if (!root) {
      return {
        kind: "not_ready",
        reason: "hydrating",
      };
    }

    const title = normalizeContent(
      document.querySelector(TITLE_SELECTOR)?.textContent ?? document.title,
    );
    if (title.length === 0) {
      return {
        kind: "not_ready",
        reason: "hydrating",
      };
    }

    const authorName = normalizeContent(
      document.querySelector(AUTHOR_META_SELECTOR)?.getAttribute("content") ?? "",
    );
    if (authorName.length === 0) {
      return {
        kind: "not_ready",
        reason: "hydrating",
      };
    }

    const imageCandidates = extractMetaImageCandidates(document);
    const substackPostId = parseSubstackPostId(imageCandidates);
    if (substackPostId === null || substackPostId.length === 0) {
      return {
        kind: "not_ready",
        reason: "missing_identity",
      };
    }

    const publicationSubdomain = parsePublicationSubdomain(parsedUrl, imageCandidates);
    if (publicationSubdomain === null || publicationSubdomain.length === 0) {
      return {
        kind: "not_ready",
        reason: "missing_identity",
      };
    }

    const extractedContent = extractContentWithImageOccurrencesFromRoot(root, url);
    const contentText = extractedContent.contentText;

    const subtitle = normalizeContent(document.querySelector(SUBTITLE_SELECTOR)?.textContent ?? "");
    const publishedAt = extractPublishedAt(document, root);
    const interactionCounts = extractInteractionCounts(document);
    const authorSubstackHandle = extractAuthorHandle(document);

    const imageUrls = extractedContent.imageUrls;
    const hasVideo = root.querySelector("video, iframe") !== null;
    const mediaState = imageUrls.length > 0 ? "has_images" : hasVideo ? "has_video" : "text_only";

    return {
      kind: "ready",
      content: {
        platform: "SUBSTACK",
        externalId: substackPostId,
        url,
        contentText,
        mediaState,
        imageUrls,
        imageOccurrences: extractedContent.imageOccurrences,
        metadata: {
          substackPostId,
          publicationSubdomain,
          slug,
          title,
          authorName,
          ...(subtitle.length === 0 ? {} : { subtitle }),
          ...(authorSubstackHandle === undefined ? {} : { authorSubstackHandle }),
          ...(publishedAt === null ? {} : { publishedAt }),
          ...(interactionCounts.likeCount === undefined
            ? {}
            : { likeCount: interactionCounts.likeCount }),
          ...(interactionCounts.commentCount === undefined
            ? {}
            : { commentCount: interactionCounts.commentCount }),
        },
      },
    };
  },

  getContentRoot(document: Document): Element | null {
    return document.querySelector(CONTENT_SELECTOR);
  },
};
