/**
 * Wikipedia URL identity parsing and metadata canonicalization.
 *
 * Derives deterministic external IDs for Wikipedia articles from URLs and
 * extension-submitted metadata. The external ID is `{language}:{pageId}`,
 * which uniquely identifies an article across language editions.
 */

import {
  normalizeWikipediaTitleToken,
  parseWikipediaIdentity,
  wikipediaExternalIdFromPageId,
  type ViewPostInput,
} from "@openerrata/shared";
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
  const urlIdentity = parseWikipediaIdentity(input.url);
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

  return wikipediaExternalIdFromPageId(input.metadata.language, input.metadata.pageId);
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
