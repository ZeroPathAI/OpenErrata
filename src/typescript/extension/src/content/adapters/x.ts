import { normalizeContent } from "@openerrata/shared";
import type { AdapterExtractionResult, PlatformAdapter } from "./model";
import {
  extractContentWithImageOccurrencesFromRoot,
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
const TWEET_CONTAINER_SELECTOR = "article";
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
  return X_STATUS_HOSTS.some((host) => normalized === host || normalized.endsWith(`.${host}`));
}

function parseStatusFromPath(pathname: string): {
  tweetId: string;
  authorHandle: string | null;
} | null {
  const webMatch = WEB_STATUS_PATH_REGEX.exec(pathname);
  if (webMatch?.[1] !== undefined && webMatch[1].length > 0) {
    return {
      tweetId: webMatch[1],
      authorHandle: null,
    };
  }

  const iStatusMatch = I_STATUS_PATH_REGEX.exec(pathname);
  if (iStatusMatch?.[1] !== undefined && iStatusMatch[1].length > 0) {
    return {
      tweetId: iStatusMatch[1],
      authorHandle: null,
    };
  }

  const handleMatch = HANDLE_STATUS_PATH_REGEX.exec(pathname);
  if (handleMatch?.[2] !== undefined && handleMatch[2].length > 0) {
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
  if (href === null || href === undefined || href.length === 0) return null;
  try {
    const parsed = new URL(href, window.location.origin);
    return parseStatusFromPath(parsed.pathname);
  } catch {
    return null;
  }
}

function isStatusHrefForTweetId(href: string | null | undefined, tweetId: string): boolean {
  return parseStatusFromHref(href)?.tweetId === tweetId;
}

function hasDocumentLevelTweetIdentity(document: Document, tweetId: string): boolean {
  const hrefCandidates = [
    document.querySelector('meta[property="og:url"]')?.getAttribute("content"),
    document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
  ];
  return hrefCandidates.some((href) => parseStatusFromHref(href)?.tweetId === tweetId);
}

type TweetContainerSelection =
  | {
      kind: "ready";
      container: HTMLElement;
    }
  | {
      kind: "not_ready";
      reason: "hydrating" | "ambiguous_dom" | "missing_identity";
    };

function pickTargetTweetContainer(document: Document, tweetId: string): TweetContainerSelection {
  const permalinkCandidates = document.querySelectorAll<HTMLAnchorElement>(
    `${TWEET_CONTAINER_SELECTOR} a[href*="/status/${tweetId}"]`,
  );
  const permalinkContainers = new Set<HTMLElement>();
  for (const candidate of permalinkCandidates) {
    if (!isStatusHrefForTweetId(candidate.getAttribute("href"), tweetId)) {
      continue;
    }
    const container = candidate.closest<HTMLElement>(TWEET_CONTAINER_SELECTOR);
    if (container) {
      permalinkContainers.add(container);
    }
  }

  if (permalinkContainers.size === 1) {
    const [container] = Array.from(permalinkContainers);
    if (!container) {
      throw new Error("Expected one permalink-matching X tweet container");
    }
    return {
      kind: "ready",
      container,
    };
  }

  if (permalinkContainers.size > 1) {
    return {
      kind: "not_ready",
      reason: "ambiguous_dom",
    };
  }

  // In some route variants, the primary column contains only the target tweet.
  // Require canonical/og identity proof before using this fallback.
  const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
  if (primaryColumn) {
    const articles = Array.from(
      primaryColumn.querySelectorAll<HTMLElement>(TWEET_CONTAINER_SELECTOR),
    );
    if (articles.length === 1 && hasDocumentLevelTweetIdentity(document, tweetId)) {
      const [container] = articles;
      if (!container) {
        throw new Error("Expected one primary-column X tweet container");
      }
      return {
        kind: "ready",
        container,
      };
    }

    if (articles.length > 1 && hasDocumentLevelTweetIdentity(document, tweetId)) {
      return {
        kind: "not_ready",
        reason: "ambiguous_dom",
      };
    }
  }

  if (hasDocumentLevelTweetIdentity(document, tweetId)) {
    return {
      kind: "not_ready",
      reason: "hydrating",
    };
  }

  return {
    kind: "not_ready",
    reason: "missing_identity",
  };
}

function normalizeAuthorHandle(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.length === 0) return null;
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

function parseStatusFromUrl(url: string): { tweetId: string; authorHandle: string | null } | null {
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
    document.querySelector('meta[property="og:url"]')?.getAttribute("content"),
    document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
    ...Array.from(
      tweetContainer.querySelectorAll<HTMLAnchorElement>(`a[href*="/status/${tweetId}"]`),
    ).map((a) => a.getAttribute("href")),
    ...Array.from(
      document.querySelectorAll<HTMLAnchorElement>(`a[href*="/status/${tweetId}"]`),
    ).map((a) => a.getAttribute("href")),
  ];

  for (const href of hrefCandidates) {
    const handle = extractAuthorHandleFromHref(href, tweetId);
    if (handle !== null && handle.length > 0) return handle;
  }

  const profileHref =
    tweetContainer
      .querySelector<HTMLAnchorElement>('[data-testid="User-Name"] a[href^="/"]')
      ?.getAttribute("href") ??
    document
      .querySelector<HTMLAnchorElement>('[data-testid="User-Name"] a[href^="/"]')
      ?.getAttribute("href");

  if (profileHref !== undefined && profileHref !== null && profileHref.length > 0) {
    try {
      const parsed = new URL(profileHref, window.location.origin);
      const segment = parsed.pathname.split("/").find(Boolean);
      const handleFromProfile = normalizeAuthorHandle(segment);
      if (handleFromProfile !== null && handleFromProfile.length > 0) return handleFromProfile;
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
    const match = HANDLE_TEXT_REGEX.exec(normalized);
    if (match?.[1] === undefined || match[1].length === 0) continue;
    const handleFromText = normalizeAuthorHandle(match[1]);
    if (handleFromText !== null && handleFromText.length > 0) return handleFromText;
  }

  return null;
}

function hasSupportedStatusPath(url: string): boolean {
  return parseStatusFromUrl(url) !== null;
}

function hasPrivateOrGatedMessage(document: Document, tweetId: string): boolean {
  if (pickTargetTweetContainer(document, tweetId).kind === "ready") {
    return false;
  }

  const primaryColumn = document.querySelector('[data-testid="primaryColumn"]') ?? document.body;
  const text = normalizeContent(primaryColumn.textContent);
  if (text.length === 0) {
    return false;
  }

  return PRIVATE_OR_GATED_PATTERNS.some((pattern) => pattern.test(text));
}

export const xAdapter: PlatformAdapter = {
  platformKey: "X",
  contentRootSelector: TWEET_TEXT_SELECTOR,

  matches(url: string): boolean {
    return hasSupportedStatusPath(url);
  },

  detectPrivateOrGated(document: Document): boolean {
    const statusFromUrl = parseStatusFromUrl(window.location.href);
    if (!statusFromUrl) return false;
    return hasPrivateOrGatedMessage(document, statusFromUrl.tweetId);
  },

  extract(document: Document): AdapterExtractionResult {
    const url = window.location.href;
    const statusFromUrl = parseStatusFromUrl(url);
    if (!statusFromUrl) {
      return {
        kind: "not_ready",
        reason: "unsupported",
      };
    }

    const tweetId = statusFromUrl.tweetId;
    const tweetSelection = pickTargetTweetContainer(document, tweetId);
    if (tweetSelection.kind !== "ready") {
      return {
        kind: "not_ready",
        reason: tweetSelection.reason,
      };
    }
    const tweetContainer = tweetSelection.container;

    const tweetTextEl = tweetContainer.querySelector(TWEET_TEXT_SELECTOR);
    if (!tweetTextEl) {
      return {
        kind: "not_ready",
        reason: "unsupported",
      };
    }

    const contentText = normalizeContent(tweetTextEl.textContent);
    const extractedContent = extractContentWithImageOccurrencesFromRoot(
      tweetContainer,
      window.location.origin,
      '[data-testid="tweetPhoto"] img, [data-testid="card.wrapper"] img, img[src*="twimg.com/media"]',
    );
    // Tweet media attachments live outside tweetText on X; keep text scoped to
    // tweetText and attach images at the end of that text stream.
    const imageOccurrences = extractedContent.imageOccurrences.map((occurrence, originalIndex) => ({
      ...occurrence,
      originalIndex,
      normalizedTextOffset: contentText.length,
    }));
    const authorDisplayName = normalizeContent(
      tweetContainer.querySelector('[data-testid="User-Name"]')?.textContent ?? "",
    );

    // Extract images separately from video detection so image posts are investigated.
    const imageUrls = extractedContent.imageUrls;

    const hasVideo =
      tweetContainer.querySelector(
        '[data-testid="videoPlayer"], [data-testid="videoPlayer"] video, [data-testid="card.wrapper"] video',
      ) !== null;
    const mediaState = imageUrls.length > 0 ? "has_images" : hasVideo ? "has_video" : "text_only";

    const authorHandle =
      statusFromUrl.authorHandle ?? inferAuthorHandle(document, tweetContainer, tweetId);
    if (authorHandle === null || authorHandle.length === 0) {
      return {
        kind: "not_ready",
        reason: "missing_identity",
      };
    }
    const postedAt = extractPostedAt(document, tweetContainer);

    return {
      kind: "ready",
      content: {
        platform: "X",
        externalId: tweetId,
        url,
        contentText,
        mediaState,
        imageUrls,
        imageOccurrences,
        metadata: {
          authorHandle,
          authorDisplayName: authorDisplayName.length > 0 ? authorDisplayName : null,
          text: contentText,
          mediaUrls: imageUrls,
          ...(postedAt === null ? {} : { postedAt }),
        },
      },
    };
  },

  getContentRoot(document: Document): Element | null {
    const statusFromUrl = parseStatusFromUrl(window.location.href);
    if (!statusFromUrl) return null;
    const tweetSelection = pickTargetTweetContainer(document, statusFromUrl.tweetId);
    if (tweetSelection.kind !== "ready") return null;
    const tweetContainer = tweetSelection.container;
    return tweetContainer.querySelector(TWEET_TEXT_SELECTOR);
  },
};
