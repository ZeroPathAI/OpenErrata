import {
  normalizeContent,
  observedImageUrlsFromOccurrences,
  xExternalIdSchema,
} from "@openerrata/shared";
import {
  normalizeXHandle,
  pageLocatorFor,
  parseXStatusPath,
  type PageLocator,
} from "../../lib/page-locator";
import { buildDomTextIndex } from "../dom-text-index";
import { excludeNothing, type AdapterExtractionResult, type PlatformAdapter } from "./model";
import { detachedImageOccurrences, readFirstMetaDateAsIso, readFirstTimeDateAsIso } from "./utils";

// X serves two frontends. Logged in, tweet parts carry `data-testid`
// attributes (`tweetText`, `User-Name`, `videoPlayer`, ...). Logged out (seen
// 2026-10) there are no test ids at all: each tweet is a plain `<article>`
// whose text is a `div[dir="auto"]` after the author header.
const LOGGED_IN_TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
const LOGGED_OUT_TWEET_TEXT_SELECTOR = 'div[dir="auto"]';
const TWEET_CONTAINER_SELECTOR = "article";
const TWEET_IMAGE_SELECTOR =
  '[data-testid="tweetPhoto"] img, [data-testid="card.wrapper"] img, img[src*="twimg.com/media"]';
const TWEET_VIDEO_SELECTOR = '[data-testid="videoPlayer"], video';
const HANDLE_TEXT_REGEX = /^@([A-Za-z0-9_]{1,15})$/;
const META_DATE_SELECTORS = [
  'meta[property="article:published_time"]',
  'meta[name="article:published_time"]',
  'meta[property="og:article:published_time"]',
] as const;
const PRIVATE_OR_GATED_PATTERNS = [
  /these posts are protected/i,
  /only confirmed followers have access/i,
  /unable to view this post/i,
  /account owner limits who can view their posts/i,
  /this account['’]s posts are protected/i,
] as const;

type XLocator = Extract<PageLocator, { platform: "X" }>;

function xLocator(url: string): XLocator | null {
  const locator = pageLocatorFor("X", url);
  return locator?.platform === "X" ? locator : null;
}

function parseStatusFromHref(href: string | null | undefined): {
  tweetId: string;
  authorHandle: string | null;
} | null {
  if (href === null || href === undefined || href.length === 0) return null;
  try {
    return parseXStatusPath(new URL(href, window.location.origin).pathname);
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

/** The handle a tweet article's first profile link (the author's avatar/name) points to. */
function articleAuthorHandle(tweetContainer: Element): string | null {
  const href = tweetContainer.querySelector('a[href^="/"]')?.getAttribute("href");
  if (href === null || href === undefined) return null;
  return normalizeXHandle(href.split(/[/?#]/).find(Boolean));
}

/**
 * The tweet's own text element: logged-in `tweetText`, else (logged out) the
 * first `div[dir="auto"]` belonging to this article rather than to a nested one.
 */
function findTweetTextElement(tweetContainer: Element): Element | null {
  const loggedIn = tweetContainer.querySelector(LOGGED_IN_TWEET_TEXT_SELECTOR);
  if (loggedIn !== null) return loggedIn;
  for (const candidate of tweetContainer.querySelectorAll(LOGGED_OUT_TWEET_TEXT_SELECTOR)) {
    if (candidate.closest(TWEET_CONTAINER_SELECTOR) === tweetContainer) return candidate;
  }
  return null;
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

function pickTargetTweetContainer(document: Document, status: XLocator): TweetContainerSelection {
  const { tweetId, authorHandle } = status;
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

  // Replies and quote tweets of the target link to its permalink too; when
  // the URL names the author, the target is the one such article they wrote.
  const candidates =
    permalinkContainers.size > 1 && authorHandle !== null
      ? Array.from(permalinkContainers).filter(
          (container) =>
            articleAuthorHandle(container)?.toLowerCase() === authorHandle.toLowerCase(),
        )
      : Array.from(permalinkContainers);

  const [onlyCandidate] = candidates;
  if (candidates.length === 1 && onlyCandidate !== undefined) {
    return {
      kind: "ready",
      container: onlyCandidate,
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
    const [onlyArticle] = articles;
    if (
      articles.length === 1 &&
      onlyArticle !== undefined &&
      hasDocumentLevelTweetIdentity(document, tweetId)
    ) {
      return {
        kind: "ready",
        container: onlyArticle,
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

function extractPostedAt(document: Document, tweetContainer: Element): string | null {
  return (
    readFirstTimeDateAsIso([tweetContainer, document]) ??
    readFirstMetaDateAsIso(document, META_DATE_SELECTORS)
  );
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
    const parsed = parseStatusFromHref(href);
    if (parsed?.tweetId === tweetId && parsed.authorHandle !== null) return parsed.authorHandle;
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
      const segment = new URL(profileHref, window.location.origin).pathname
        .split("/")
        .find(Boolean);
      const handleFromProfile = normalizeXHandle(segment);
      if (handleFromProfile !== null) return handleFromProfile;
    } catch {
      // Ignore and continue with the remaining fallbacks.
    }
  }

  const handleTextCandidates = [
    ...Array.from(tweetContainer.querySelectorAll('[data-testid="User-Name"] span')),
    ...Array.from(document.querySelectorAll('[data-testid="User-Name"] span')),
  ];
  for (const candidate of handleTextCandidates) {
    const match = HANDLE_TEXT_REGEX.exec(normalizeContent(candidate.textContent));
    const handleFromText = normalizeXHandle(match?.[1]);
    if (handleFromText !== null) return handleFromText;
  }

  // Logged-out frontend: no test ids; the article opens with the author's profile link.
  return articleAuthorHandle(tweetContainer);
}

function hasPrivateOrGatedMessage(document: Document, status: XLocator): boolean {
  if (pickTargetTweetContainer(document, status).kind === "ready") {
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

  matches(url: string): boolean {
    return xLocator(url) !== null;
  },

  pageLocator(url: string): PageLocator | null {
    return xLocator(url);
  },

  detectPrivateOrGated(document: Document): boolean {
    const status = xLocator(window.location.href);
    if (!status) return false;
    return hasPrivateOrGatedMessage(document, status);
  },

  extract(document: Document): AdapterExtractionResult {
    const url = window.location.href;
    const status = xLocator(url);
    if (!status) {
      return {
        kind: "not_ready",
        reason: "unsupported",
      };
    }

    const tweetSelection = pickTargetTweetContainer(document, status);
    if (tweetSelection.kind !== "ready") {
      return {
        kind: "not_ready",
        reason: tweetSelection.reason,
      };
    }
    const tweetContainer = tweetSelection.container;

    const tweetTextEl = findTweetTextElement(tweetContainer);
    if (!tweetTextEl) {
      return {
        kind: "not_ready",
        reason: "unsupported",
      };
    }

    // Tweet media sit outside the tweet text; text stays scoped to the tweet
    // text and images are attached at the end of it.
    const contentText = buildDomTextIndex(tweetTextEl, { exclude: excludeNothing() }).text;
    const imageOccurrences = detachedImageOccurrences(tweetContainer, {
      imageSelector: TWEET_IMAGE_SELECTOR,
      baseUrl: window.location.origin,
      normalizedTextOffset: contentText.length,
    });
    const authorDisplayName = normalizeContent(
      tweetContainer.querySelector('[data-testid="User-Name"]')?.textContent ?? "",
    );

    const authorHandle =
      status.authorHandle ?? inferAuthorHandle(document, tweetContainer, status.tweetId);
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
        externalId: xExternalIdSchema.parse(status.tweetId),
        url,
        contentText,
        hasVideo: tweetContainer.querySelector(TWEET_VIDEO_SELECTOR) !== null,
        imageOccurrences,
        metadata: {
          authorHandle,
          authorDisplayName: authorDisplayName.length > 0 ? authorDisplayName : null,
          text: contentText,
          mediaUrls: observedImageUrlsFromOccurrences(imageOccurrences),
          ...(postedAt === null ? {} : { postedAt }),
        },
      },
    };
  },

  getContentRoot(document: Document): Element | null {
    const status = xLocator(window.location.href);
    if (!status) return null;
    const tweetSelection = pickTargetTweetContainer(document, status);
    if (tweetSelection.kind !== "ready") return null;
    return findTweetTextElement(tweetSelection.container);
  },

  contentExclusionFilter: excludeNothing,
};
