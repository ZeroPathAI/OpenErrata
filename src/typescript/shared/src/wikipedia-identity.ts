const WIKIPEDIA_HOST_REGEX = /^([a-z0-9-]+)(?:\.m)?\.wikipedia\.org$/i;
const WIKIPEDIA_ARTICLE_PATH_PREFIX = "/wiki/";
const WIKIPEDIA_INDEX_PATH_REGEX = /^\/w\/index\.php(?:[/?#]|$)/i;
const WIKIPEDIA_PAGE_ID_REGEX = /^\d+$/;

/**
 * Canonical (English) names of MediaWiki's non-article namespaces. MediaWiki
 * accepts these canonical names on every language edition, so they are
 * recognized regardless of host language. Localized namespace names (e.g.
 * German "Diskussion:") cannot be enumerated here; URL-level parsing therefore
 * only rules out *known* non-article pages, and callers with access to the
 * page itself must treat MediaWiki's `wgNamespaceNumber` as authoritative.
 */
const CANONICAL_NON_ARTICLE_NAMESPACE_PREFIXES = new Set([
  "talk",
  "user",
  "user talk",
  "wikipedia",
  "wikipedia talk",
  "project",
  "project talk",
  "file",
  "file talk",
  "image",
  "image talk",
  "mediawiki",
  "mediawiki talk",
  "template",
  "template talk",
  "help",
  "help talk",
  "category",
  "category talk",
  "portal",
  "portal talk",
  "book",
  "book talk",
  "draft",
  "draft talk",
  "education program",
  "education program talk",
  "timedtext",
  "timedtext talk",
  "module",
  "module talk",
  "special",
  "media",
]);

function parseLanguageFromHost(hostname: string): string | null {
  const match = WIKIPEDIA_HOST_REGEX.exec(hostname.toLowerCase());
  return match?.[1] ?? null;
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function normalizeWikipediaTitleToken(rawToken: string): string | null {
  const normalized = rawToken.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  return normalized.replace(/ /g, "_");
}

function normalizeWikipediaPathTitleToken(rawToken: string): string | null {
  const decoded = safeDecodeURIComponent(rawToken);
  if (decoded === null) {
    return null;
  }

  return normalizeWikipediaTitleToken(decoded);
}

function rawWikipediaTitleFromPath(pathname: string): string | null {
  const isArticlePath = pathname.toLowerCase().startsWith(WIKIPEDIA_ARTICLE_PATH_PREFIX);
  if (!isArticlePath) {
    return null;
  }

  const rawTitle = pathname.slice(WIKIPEDIA_ARTICLE_PATH_PREFIX.length);
  return rawTitle.length > 0 ? rawTitle : null;
}

function isArticleNamespace(title: string): boolean {
  const separator = title.indexOf(":");
  if (separator < 0) {
    return true;
  }

  const namespacePrefix = title.slice(0, separator).replace(/_/g, " ").trim().toLowerCase();
  return !CANONICAL_NON_ARTICLE_NAMESPACE_PREFIXES.has(namespacePrefix);
}

function normalizeWikipediaPageIdToken(rawToken: string | null): string | null {
  if (rawToken === null) {
    return null;
  }
  const trimmed = rawToken.trim();
  return WIKIPEDIA_PAGE_ID_REGEX.test(trimmed) ? trimmed : null;
}

function readWikipediaPageIdFromQuery(parsedUrl: URL): string | null {
  const fromCurId = normalizeWikipediaPageIdToken(parsedUrl.searchParams.get("curid"));
  if (fromCurId !== null) {
    return fromCurId;
  }
  return normalizeWikipediaPageIdToken(parsedUrl.searchParams.get("pageid"));
}

/**
 * The stored external ID of a Wikipedia article. It is always derived from the
 * numeric page ID (never the title), because titles change on page moves while
 * page IDs do not.
 */
export function wikipediaExternalIdFromPageId(language: string, pageId: string): string {
  return `${language}:${pageId}`;
}

/**
 * What a Wikipedia URL alone says about which article it shows. A URL either
 * names the article by numeric page ID (`?curid=` / `?pageid=`, possibly
 * alongside a title) or only by title; a title-only URL cannot yield the
 * external ID, which needs the page ID from the page itself.
 */
export type WikipediaUrlIdentity =
  | { kind: "PAGE_ID"; language: string; pageId: string; title: string | null }
  | { kind: "TITLE"; language: string; title: string };

/**
 * Parse Wikipedia article identity from a URL, for both extension and API.
 * Returns null for non-Wikipedia URLs and for titles in known non-article
 * namespaces (see `CANONICAL_NON_ARTICLE_NAMESPACE_PREFIXES`).
 */
export function parseWikipediaUrlIdentity(url: string): WikipediaUrlIdentity | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  const language = parseLanguageFromHost(parsedUrl.hostname);
  if (language === null) {
    return null;
  }

  const pageId = readWikipediaPageIdFromQuery(parsedUrl);

  const rawTitleFromPath = rawWikipediaTitleFromPath(parsedUrl.pathname);
  const rawTitleFromQuery = WIKIPEDIA_INDEX_PATH_REGEX.test(parsedUrl.pathname)
    ? parsedUrl.searchParams.get("title")
    : null;
  const titleFromPath =
    rawTitleFromPath === null ? null : normalizeWikipediaPathTitleToken(rawTitleFromPath);
  const titleFromQuery =
    rawTitleFromQuery === null ? null : normalizeWikipediaTitleToken(rawTitleFromQuery);
  const title = titleFromPath ?? titleFromQuery;

  if (title !== null && !isArticleNamespace(title)) {
    return null;
  }
  if (pageId !== null) {
    return { kind: "PAGE_ID", language, pageId, title };
  }
  if (title !== null) {
    return { kind: "TITLE", language, title };
  }
  return null;
}
