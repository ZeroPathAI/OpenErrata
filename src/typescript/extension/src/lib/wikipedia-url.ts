const WIKIPEDIA_HOST_REGEX = /^([a-z0-9-]+)(?:\.m)?\.wikipedia\.org$/i;
const WIKIPEDIA_ARTICLE_PATH_PREFIX = "/wiki/";
const WIKIPEDIA_INDEX_PATH_REGEX = /^\/w\/index\.php(?:[/?#]|$)/i;
const WIKIPEDIA_PAGE_ID_REGEX = /^\d+$/;

const NON_ARTICLE_NAMESPACE_PREFIXES = new Set([
  "talk",
  "user",
  "user talk",
  "wikipedia",
  "wikipedia talk",
  "file",
  "file talk",
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
  const match = hostname.toLowerCase().match(WIKIPEDIA_HOST_REGEX);
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
  return !NON_ARTICLE_NAMESPACE_PREFIXES.has(namespacePrefix);
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

function wikipediaExternalIdFromTitle(language: string, title: string): string {
  return `${language}:${title}`;
}

export function wikipediaExternalIdFromPageId(language: string, pageId: string): string {
  return `${language}:${pageId}`;
}

type ParsedWikipediaIdentity = {
  language: string;
  title: string | null;
  pageId: string | null;
  identityKind: "TITLE" | "PAGE_ID";
  externalId: string;
};

export function parseWikipediaIdentity(url: string): ParsedWikipediaIdentity | null {
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
  if (title === null && pageId === null) {
    return null;
  }

  if (pageId !== null) {
    return {
      language,
      title,
      pageId,
      identityKind: "PAGE_ID",
      externalId: wikipediaExternalIdFromPageId(language, pageId),
    };
  }
  if (title === null) {
    return null;
  }

  return {
    language,
    title,
    pageId: null,
    identityKind: "TITLE",
    externalId: wikipediaExternalIdFromTitle(language, title),
  };
}
