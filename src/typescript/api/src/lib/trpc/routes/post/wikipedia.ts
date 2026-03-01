/**
 * Wikipedia URL identity parsing and metadata canonicalization.
 *
 * Derives deterministic external IDs for Wikipedia articles from URLs and
 * extension-submitted metadata. The external ID is `{language}:{pageId}`,
 * which uniquely identifies an article across language editions.
 */

import type { ViewPostInput } from "@openerrata/shared";
import { TRPCError } from "@trpc/server";

type WikipediaViewInput = Extract<ViewPostInput, { platform: "WIKIPEDIA" }>;

export type PreparedWikipediaViewInput = WikipediaViewInput & {
  derivedExternalId: string;
};

/**
 * `ViewPostInput` narrowed by Wikipedia-specific preparation. For Wikipedia
 * posts the `derivedExternalId` field is attached; for all other platforms
 * the input is passed through unchanged.
 */
export type PreparedViewPostInput =
  | Exclude<ViewPostInput, { platform: "WIKIPEDIA" }>
  | PreparedWikipediaViewInput;

const WIKIPEDIA_HOST_REGEX = /^([a-z0-9-]+)(?:\.m)?\.wikipedia\.org$/i;
const WIKIPEDIA_ARTICLE_PATH_PREFIX = "/wiki/";
const WIKIPEDIA_INDEX_PATH_REGEX = /^\/w\/index\.php(?:[/?#]|$)/i;
const WIKIPEDIA_PAGE_ID_REGEX = /^\d+$/;

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeWikipediaTitleToken(rawToken: string): string | null {
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

function parseWikipediaPageIdToken(rawToken: string | null): string | null {
  if (rawToken === null) {
    return null;
  }
  const trimmed = rawToken.trim();
  return WIKIPEDIA_PAGE_ID_REGEX.test(trimmed) ? trimmed : null;
}

function parseWikipediaIdentityFromUrl(url: string): {
  language: string;
  title: string | null;
  pageId: string | null;
} | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  const hostMatch = WIKIPEDIA_HOST_REGEX.exec(parsedUrl.hostname);
  const language = hostMatch?.[1]?.toLowerCase();
  if (language === undefined || language.length === 0) {
    return null;
  }

  const pageId =
    parseWikipediaPageIdToken(parsedUrl.searchParams.get("curid")) ??
    parseWikipediaPageIdToken(parsedUrl.searchParams.get("pageid"));

  const rawTitleFromPath = rawWikipediaTitleFromPath(parsedUrl.pathname);
  const rawTitleFromQuery = WIKIPEDIA_INDEX_PATH_REGEX.test(parsedUrl.pathname)
    ? parsedUrl.searchParams.get("title")
    : null;
  const titleFromPath =
    rawTitleFromPath === null ? null : normalizeWikipediaPathTitleToken(rawTitleFromPath);
  const titleFromQuery =
    rawTitleFromQuery === null ? null : normalizeWikipediaTitleToken(rawTitleFromQuery);
  const title = titleFromPath ?? titleFromQuery;

  if (title === null && pageId === null) {
    return null;
  }

  return {
    language,
    title,
    pageId,
  };
}

function canonicalizeWikipediaMetadata(
  metadata: WikipediaViewInput["metadata"],
): WikipediaViewInput["metadata"] {
  const title = normalizeWikipediaTitleToken(metadata.title);
  if (title === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Wikipedia metadata.title is invalid",
    });
  }

  return {
    ...metadata,
    language: metadata.language.trim().toLowerCase(),
    title,
    pageId: metadata.pageId.trim(),
    revisionId: metadata.revisionId.trim(),
  };
}

function deriveWikipediaExternalId(
  input: Pick<WikipediaViewInput, "url"> & { metadata: WikipediaViewInput["metadata"] },
): string {
  const urlIdentity = parseWikipediaIdentityFromUrl(input.url);
  if (urlIdentity === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Wikipedia URL must identify an article title or page ID",
    });
  }

  if (urlIdentity.language !== input.metadata.language) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Wikipedia metadata.language does not match URL host language",
    });
  }

  if (urlIdentity.pageId !== null && urlIdentity.pageId !== input.metadata.pageId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Wikipedia metadata.pageId does not match URL page ID",
    });
  }

  if (
    urlIdentity.pageId === null &&
    urlIdentity.title !== null &&
    urlIdentity.title !== input.metadata.title
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Wikipedia metadata.title does not match URL article title",
    });
  }

  return `${input.metadata.language}:${input.metadata.pageId}`;
}

/**
 * Normalizes platform-specific input before the content storage pipeline.
 * For Wikipedia posts this canonicalizes metadata and derives a deterministic
 * `externalId`; for all other platforms the input passes through unchanged.
 */
export function prepareViewPostInput(input: ViewPostInput): PreparedViewPostInput {
  if (input.platform !== "WIKIPEDIA") {
    return input;
  }

  const metadata = canonicalizeWikipediaMetadata(input.metadata);
  return {
    ...input,
    metadata,
    derivedExternalId: deriveWikipediaExternalId({
      url: input.url,
      metadata,
    }),
  };
}
