/**
 * What a page URL alone says about which post it shows (spec §3.8). URLs are
 * parsed here, once, for every consumer: adapters (post identity and
 * metadata), the content script (session keys of skipped pages), the
 * background (which tabs may need a content script) and the popup (whether a
 * cached status still describes the tab's page).
 *
 * A locator is not always the post's external ID: Substack URLs carry a slug
 * (the external ID is the numeric post ID from page metadata) and Wikipedia
 * URLs may carry only a title (the external ID needs the page ID).
 */
import {
  parseWikipediaUrlIdentity,
  type Platform,
  type WikipediaUrlIdentity,
} from "@openerrata/shared";

export type PageLocator =
  | { platform: "LESSWRONG"; postId: string; slug: string | null }
  | { platform: "X"; tweetId: string; authorHandle: string | null }
  | { platform: "SUBSTACK"; origin: string; slug: string }
  | { platform: "WIKIPEDIA"; article: WikipediaUrlIdentity };

const LESSWRONG_HOSTS = new Set(["lesswrong.com", "www.lesswrong.com"]);
const LESSWRONG_POST_PATH_REGEX = /^\/posts\/([A-Za-z0-9]+)(?:\/([^/?#]*))?(?:\/|$)/;

const X_HOSTS = ["x.com", "twitter.com"] as const;
const X_HANDLE_STATUS_PATH_REGEX = /^\/([^/]+)\/status\/(\d+)(?:\/|$)/i;
const X_ANONYMOUS_STATUS_PATH_REGEXES = [
  /^\/i\/web\/status\/(\d+)(?:\/|$)/i,
  /^\/i\/status\/(\d+)(?:\/|$)/i,
] as const;
/** First path segments that are X app routes, not user handles. */
const X_RESERVED_HANDLE_SEGMENTS = new Set([
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

const SUBSTACK_POST_PATH_REGEX = /^\/p\/([^/?#]+)/i;
const SUBSTACK_HOST_REGEX = /(^|\.)substack\.com$/i;

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A user handle from a URL path segment, or null for app routes. */
export function normalizeXHandle(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const handle = raw.trim().replace(/^@/, "");
  if (handle.length === 0 || X_RESERVED_HANDLE_SEGMENTS.has(handle.toLowerCase())) return null;
  return handle;
}

/** Status ID (and author handle when the path names one) of an X status path. */
export function parseXStatusPath(
  pathname: string,
): { tweetId: string; authorHandle: string | null } | null {
  for (const regex of X_ANONYMOUS_STATUS_PATH_REGEXES) {
    const tweetId = regex.exec(pathname)?.[1];
    if (tweetId !== undefined) return { tweetId, authorHandle: null };
  }
  const handleMatch = X_HANDLE_STATUS_PATH_REGEX.exec(pathname);
  const tweetId = handleMatch?.[2];
  if (tweetId === undefined) return null;
  return { tweetId, authorHandle: normalizeXHandle(handleMatch?.[1]) };
}

function isXHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return X_HOSTS.some((host) => normalized === host || normalized.endsWith(`.${host}`));
}

export function isSubstackHost(hostname: string): boolean {
  return SUBSTACK_HOST_REGEX.test(hostname) && hostname.toLowerCase() !== "substack.com";
}

function lesswrongLocator(url: URL): PageLocator | null {
  if (!LESSWRONG_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = LESSWRONG_POST_PATH_REGEX.exec(url.pathname);
  const postId = match?.[1];
  if (postId === undefined) return null;
  const slug = match?.[2];
  return {
    platform: "LESSWRONG",
    postId,
    slug: slug === undefined || slug.length === 0 ? null : decodePathSegment(slug),
  };
}

function xLocator(url: URL): PageLocator | null {
  if (!isXHost(url.hostname)) return null;
  const status = parseXStatusPath(url.pathname);
  return status === null ? null : { platform: "X", ...status };
}

/** Any host's `/p/{slug}` path: custom-domain Substack publications use arbitrary hosts. */
function substackLocator(url: URL): PageLocator | null {
  const slug = SUBSTACK_POST_PATH_REGEX.exec(url.pathname)?.[1];
  if (slug === undefined) return null;
  return { platform: "SUBSTACK", origin: url.origin, slug: decodePathSegment(slug) };
}

function wikipediaLocator(url: URL): PageLocator | null {
  const article = parseWikipediaUrlIdentity(url.href);
  return article === null ? null : { platform: "WIKIPEDIA", article };
}

/**
 * The locator of `url` read as a page of `platform`, or null if the URL cannot
 * be a post page of that platform. For Substack any host qualifies (custom
 * domains); whether the page really is Substack is a DOM question.
 */
export function pageLocatorFor(platform: Platform, url: string): PageLocator | null {
  const parsed = parseUrl(url);
  if (parsed === null) return null;
  switch (platform) {
    case "LESSWRONG":
      return lesswrongLocator(parsed);
    case "X":
      return xLocator(parsed);
    case "SUBSTACK":
      return substackLocator(parsed);
    case "WIKIPEDIA":
      return wikipediaLocator(parsed);
  }
}

/**
 * The locator of a post page on one of the platforms' own hosts (URL-first
 * platform detection). Custom-domain Substack pages are not recognized here.
 */
export function knownHostPageLocator(url: string): PageLocator | null {
  const parsed = parseUrl(url);
  if (parsed === null) return null;
  return (
    lesswrongLocator(parsed) ??
    xLocator(parsed) ??
    (isSubstackHost(parsed.hostname) ? substackLocator(parsed) : null) ??
    wikipediaLocator(parsed)
  );
}

/** A `/p/{slug}` page on a host that is not a known platform host. */
export function isPossibleCustomDomainSubstackPage(url: string): boolean {
  return knownHostPageLocator(url) === null && pageLocatorFor("SUBSTACK", url) !== null;
}

/** Stable string form of a locator, for session keys. */
export function pageLocatorKey(locator: PageLocator): string {
  switch (locator.platform) {
    case "LESSWRONG":
      return `LESSWRONG:${locator.postId}`;
    case "X":
      return `X:${locator.tweetId}`;
    case "SUBSTACK":
      return `SUBSTACK:${locator.origin}/p/${locator.slug}`;
    case "WIKIPEDIA": {
      const { article } = locator;
      return article.kind === "PAGE_ID"
        ? `WIKIPEDIA:${article.language}:page:${article.pageId}`
        : `WIKIPEDIA:${article.language}:title:${article.title}`;
    }
  }
}

/**
 * Whether two locators denote the same post page. Wikipedia URLs name an
 * article by page ID and/or title, so they match when either agrees.
 */
export function isSamePage(left: PageLocator, right: PageLocator): boolean {
  if (left.platform === "WIKIPEDIA" && right.platform === "WIKIPEDIA") {
    const a = left.article;
    const b = right.article;
    if (a.language !== b.language) return false;
    const aPageId = a.kind === "PAGE_ID" ? a.pageId : null;
    const bPageId = b.kind === "PAGE_ID" ? b.pageId : null;
    if (aPageId !== null && bPageId !== null) return aPageId === bPageId;
    return a.title !== null && a.title === b.title;
  }
  return pageLocatorKey(left) === pageLocatorKey(right);
}
