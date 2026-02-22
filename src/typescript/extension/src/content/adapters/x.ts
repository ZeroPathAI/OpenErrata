import type { PlatformContent } from "@openerrata/shared";
import { normalizeContent } from "@openerrata/shared";
import type { PlatformAdapter } from "./lesswrong";
import {
  extractImageUrlsFromRoot,
  readFirstMetaDateAsIso,
  readFirstTimeDateAsIso,
} from "./utils";

const HANDLE_STATUS_PATH_REGEX = /^\/([^/]+)\/status\/(\d+)(?:\/|$)/i;
const WEB_STATUS_PATH_REGEX = /^\/i\/web\/status\/(\d+)(?:\/|$)/i;
const I_STATUS_PATH_REGEX = /^\/i\/status\/(\d+)(?:\/|$)/i;
const HANDLE_TEXT_REGEX = /^@([A-Za-z0-9_]{1,15})$/;
const META_DATE_SELECTORS = [
  'meta[property="article:published_time"]',
  'meta[name="article:published_time"]',
  'meta[property="og:article:published_time"]',
] as const;
const RESERVED_HANDLE_SEGMENTS = new Set([
  "compose",
  "explore",
  "home",
  "i",
  "intent",
  "login",
  "messages",
  "notifications",
  "search",
  "settings",
  "signup",
]);

const TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
const PRIVATE_OR_GATED_PATTERNS = [
  /these posts are protected/i,
  /only confirmed followers have access/i,
  /unable to view this post/i,
  /account owner limits who can view their posts/i,
  /this account['\u2019]s posts are protected/i,
] as const;
const X_STATUS_HOSTS = ["x.com", "twitter.com"] as const;

function isSupportedXHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return X_STATUS_HOSTS.some(
    (host) => normalized === host || normalized.endsWith(`.${host}`),
  );
}

function parseStatusFromPath(pathname: string): {
  tweetId: string;
  authorHandle: string | null;
} | null {
  const webMatch = pathname.match(WEB_STATUS_PATH_REGEX);
  if (webMatch?.[1]) {
    return {
      tweetId: webMatch[1],
      authorHandle: null,
    };
  }

  const iStatusMatch = pathname.match(I_STATUS_PATH_REGEX);
  if (iStatusMatch?.[1]) {
    return {
      tweetId: iStatusMatch[1],
      authorHandle: null,
    };
  }

  const handleMatch = pathname.match(HANDLE_STATUS_PATH_REGEX);
  if (handleMatch?.[2]) {
    return {
      tweetId: handleMatch[2],
      authorHandle: normalizeAuthorHandle(handleMatch[1]),
    };
  }

  return null;
}

function parseStatusFromHref(href: string | null | undefined): {
  tweetId: string;
  authorHandle: string | null;
} | null {
  if (!href) return null;
  try {
    const parsed = new URL(href, window.location.origin);
    return parseStatusFromPath(parsed.pathname);
  } catch {
    return null;
  }
}

function isStatusHrefForTweetId(
  href: string | null | undefined,
  tweetId: string,
): boolean {
  return parseStatusFromHref(href)?.tweetId === tweetId;
}

function hasDocumentLevelTweetIdentity(document: Document, tweetId: string): boolean {
  const hrefCandidates = [
    document.querySelector('meta[property="og:url"]')?.getAttribute("content"),
    document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
  ];
  return hrefCandidates.some((href) => parseStatusFromHref(href)?.tweetId === tweetId);
}

function findTargetTweetContainer(document: Document, tweetId: string): Element | null {
  const permalinkCandidates = document.querySelectorAll<HTMLAnchorElement>(
    `article a[href*="/status/${tweetId}"]`,
  );
  for (const candidate of permalinkCandidates) {
    if (!isStatusHrefForTweetId(candidate.getAttribute("href"), tweetId)) {
      continue;
    }
    const container = candidate.closest("article");
    if (container) {
      return container;
    }
  }

  // In some route variants, the primary column contains only the target tweet.
  // Require canonical/og identity proof before using this fallback.
  const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
  if (!primaryColumn) return null;
  const articles = primaryColumn.querySelectorAll("article");
  if (articles.length !== 1) return null;
  if (!hasDocumentLevelTweetIdentity(document, tweetId)) return null;
  return articles[0] ?? null;
}

function normalizeAuthorHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.trim().replace(/^@/, "");
  if (normalized.length === 0) return null;
  if (RESERVED_HANDLE_SEGMENTS.has(normalized.toLowerCase())) return null;
  return normalized;
}

function extractPostedAt(document: Document, tweetContainer: Element): string | null {
  return (
    readFirstTimeDateAsIso([tweetContainer, document]) ??
    readFirstMetaDateAsIso(document, META_DATE_SELECTORS)
  );
}

function parseStatusFromUrl(
  url: string,
): { tweetId: string; authorHandle: string | null } | null {
  try {
    const parsed = new URL(url);
    if (!isSupportedXHost(parsed.hostname)) return null;
    return parseStatusFromPath(parsed.pathname);
  } catch {
    return null;
  }
}

function extractAuthorHandleFromHref(
  href: string | null | undefined,
  tweetId: string,
): string | null {
  const parsed = parseStatusFromHref(href);
  if (parsed?.tweetId !== tweetId) return null;
  return parsed.authorHandle;
}

function inferAuthorHandle(
  document: Document,
  tweetContainer: Element,
  tweetId: string,
): string | null {
  const hrefCandidates = [
    document
      .querySelector('meta[property="og:url"]')
      ?.getAttribute("content"),
    document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
    ...Array.from(
      tweetContainer.querySelectorAll<HTMLAnchorElement>(
        `a[href*="/status/${tweetId}"]`,
      ),
    ).map((a) => a.getAttribute("href")),
    ...Array.from(
      document.querySelectorAll<HTMLAnchorElement>(`a[href*="/status/${tweetId}"]`),
    ).map((a) => a.getAttribute("href")),
  ];

  for (const href of hrefCandidates) {
    const handle = extractAuthorHandleFromHref(href, tweetId);
    if (handle) return handle;
  }

  const profileHref =
    tweetContainer
      .querySelector<HTMLAnchorElement>('[data-testid="User-Name"] a[href^="/"]')
      ?.getAttribute("href") ??
    document
      .querySelector<HTMLAnchorElement>('[data-testid="User-Name"] a[href^="/"]')
      ?.getAttribute("href");

  if (profileHref) {
    try {
      const parsed = new URL(profileHref, window.location.origin);
      const segment = parsed.pathname.split("/").find(Boolean);
      const handleFromProfile = normalizeAuthorHandle(segment);
      if (handleFromProfile) return handleFromProfile;
    } catch {
      // Ignore and continue with text fallback.
    }
  }

  const handleTextCandidates = [
    ...Array.from(tweetContainer.querySelectorAll('[data-testid="User-Name"] span')),
    ...Array.from(document.querySelectorAll('[data-testid="User-Name"] span')),
  ];
  for (const candidate of handleTextCandidates) {
    const normalized = normalizeContent(candidate.textContent);
    const match = normalized.match(HANDLE_TEXT_REGEX);
    if (!match?.[1]) continue;
    const handleFromText = normalizeAuthorHandle(match[1]);
    if (handleFromText) return handleFromText;
  }

  return null;
}

function hasSupportedStatusPath(url: string): boolean {
  return parseStatusFromUrl(url) !== null;
}

function hasPrivateOrGatedMessage(document: Document, tweetId: string): boolean {
  if (findTargetTweetContainer(document, tweetId) !== null) {
    return false;
  }

  const primaryColumn =
    document.querySelector('[data-testid="primaryColumn"]') ?? document.body;
  const text = normalizeContent(primaryColumn.textContent);
  if (text.length === 0) {
    return false;
  }

  return PRIVATE_OR_GATED_PATTERNS.some((pattern) => pattern.test(text));
}

export const xAdapter: PlatformAdapter = {
  platformKey: "X",

  matches(url: string): boolean {
    return hasSupportedStatusPath(url);
  },

  detectPrivateOrGated(document: Document): boolean {
    const statusFromUrl = parseStatusFromUrl(window.location.href);
    if (!statusFromUrl) return false;
    return hasPrivateOrGatedMessage(document, statusFromUrl.tweetId);
  },

  extract(document: Document): PlatformContent | null {
    const statusFromUrl = parseStatusFromUrl(window.location.href);
    if (!statusFromUrl) return null;

    const tweetId = statusFromUrl.tweetId;
    const tweetContainer = findTargetTweetContainer(document, tweetId);
    if (!tweetContainer) return null;

    const tweetTextEl = tweetContainer.querySelector(TWEET_TEXT_SELECTOR);
    if (!tweetTextEl) return null;

    const rawText = tweetTextEl.textContent;
    const contentText = normalizeContent(rawText);
    const authorDisplayName = normalizeContent(
      tweetContainer.querySelector('[data-testid="User-Name"]')?.textContent ?? "",
    );

    // Extract images separately from video detection so image posts are investigated.
    const imageUrls = extractImageUrlsFromRoot(
      tweetContainer,
      window.location.origin,
      '[data-testid="tweetPhoto"] img, [data-testid="card.wrapper"] img, img[src*="twimg.com/media"]',
    );

    const hasVideo =
      tweetContainer.querySelector(
        '[data-testid="videoPlayer"], [data-testid="videoPlayer"] video, [data-testid="card.wrapper"] video',
      ) !== null;
    const mediaState =
      imageUrls.length > 0
        ? "has_images"
        : hasVideo
          ? "video_only"
          : "text_only";

    const authorHandle =
      statusFromUrl.authorHandle ??
      inferAuthorHandle(document, tweetContainer, tweetId);
    if (!authorHandle) return null;
    const postedAt = extractPostedAt(document, tweetContainer);

    return {
      platform: "X",
      externalId: tweetId,
      url: window.location.href,
      contentText,
      mediaState,
      imageUrls,
      metadata: {
        authorHandle,
        authorDisplayName: authorDisplayName || null,
        text: contentText,
        mediaUrls: imageUrls,
        ...(postedAt === null ? {} : { postedAt }),
      },
    };
  },

  getContentRoot(document: Document): Element | null {
    const statusFromUrl = parseStatusFromUrl(window.location.href);
    if (!statusFromUrl) return null;
    const tweetContainer = findTargetTweetContainer(document, statusFromUrl.tweetId);
    if (!tweetContainer) return null;
    return tweetContainer.querySelector(TWEET_TEXT_SELECTOR);
  },
};
