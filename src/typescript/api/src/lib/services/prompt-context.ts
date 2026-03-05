import type { Platform } from "@openerrata/shared";
import type { Prisma } from "$lib/db/prisma-client";

export interface PromptImageOccurrence {
  originalIndex: number;
  normalizedTextOffset: number;
  sourceUrl: string;
  captionText?: string;
}

interface PromptPostContext {
  platform: Platform;
  url: string;
  authorName?: string;
  postPublishedAt?: string;
  imageOccurrences: PromptImageOccurrence[];
  hasVideo?: boolean;
}

/** Prisma include fragment that loads everything needed by `toPromptPostContext`. */
export const investigationContextInclude = {
  postVersion: {
    select: {
      serverVerifiedAt: true,
      contentBlob: {
        select: {
          contentText: true,
          contentHash: true,
        },
      },
      imageOccurrenceSet: {
        select: {
          occurrences: {
            orderBy: [{ originalIndex: "asc" }],
            select: {
              originalIndex: true,
              normalizedTextOffset: true,
              sourceUrl: true,
              captionText: true,
            },
          },
        },
      },
      lesswrongVersionMeta: {
        select: {
          publishedAt: true,
          serverHtmlBlob: { select: { htmlContent: true } },
          clientHtmlBlob: { select: { htmlContent: true } },
        },
      },
      xVersionMeta: {
        select: {
          postedAt: true,
          mediaUrls: true,
        },
      },
      substackVersionMeta: {
        select: {
          publishedAt: true,
          serverHtmlBlob: { select: { htmlContent: true } },
          clientHtmlBlob: { select: { htmlContent: true } },
        },
      },
      wikipediaVersionMeta: {
        select: {
          lastModifiedAt: true,
          serverHtmlBlob: { select: { htmlContent: true } },
          clientHtmlBlob: { select: { htmlContent: true } },
        },
      },
      post: {
        select: {
          platform: true,
          url: true,
          author: { select: { displayName: true } },
        },
      },
    },
  },
} satisfies Prisma.InvestigationInclude;

type InvestigationWithContext = Prisma.InvestigationGetPayload<{
  include: typeof investigationContextInclude;
}>;
type InvestigationVersionContext = InvestigationWithContext["postVersion"];

function unreachablePlatform(platform: never): never {
  throw new Error(`Unsupported post platform: ${String(platform)}`);
}

export function isLikelyVideoUrl(url: string): boolean {
  let pathname = url.toLowerCase();
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    // Keep best-effort behavior for malformed values already stored in metadata.
  }

  return (
    pathname.endsWith(".mp4") ||
    pathname.endsWith(".webm") ||
    pathname.endsWith(".m3u8") ||
    pathname.endsWith(".mov") ||
    pathname.endsWith(".m4v")
  );
}

export function hasXVideoMedia(mediaUrls: string[]): boolean {
  for (const mediaUrl of mediaUrls) {
    if (isLikelyVideoUrl(mediaUrl)) {
      return true;
    }
  }
  return false;
}

/**
 * Source-scoped HTML snapshots with the serverVerifiedAt latch bundled in.
 *
 * The discriminated union encodes the DB invariant:
 *   serverVerifiedAt IS NOT NULL → serverHtmlBlobId IS NOT NULL
 * When server-verified, serverHtml is guaranteed non-null at the type level.
 */
export type HtmlSnapshots =
  | { serverVerifiedAt: Date; serverHtml: string; clientHtml: string | null }
  | { serverVerifiedAt: null; serverHtml: string | null; clientHtml: string | null };

/**
 * Resolve source-scoped HTML snapshots from version metadata.
 *
 * Throws if serverVerifiedAt is set but serverHtml is absent — that state
 * violates the DB trigger that enforces the invariant, so it represents data
 * corruption and should surface immediately rather than silently falling back.
 */
export function resolveHtmlSnapshotsFromVersionMeta(
  postVersion: InvestigationVersionContext,
): HtmlSnapshots {
  const post = postVersion.post;
  let serverHtml: string | null;
  let clientHtml: string | null;
  switch (post.platform) {
    case "LESSWRONG":
      serverHtml = postVersion.lesswrongVersionMeta?.serverHtmlBlob?.htmlContent ?? null;
      clientHtml = postVersion.lesswrongVersionMeta?.clientHtmlBlob?.htmlContent ?? null;
      break;
    case "SUBSTACK":
      serverHtml = postVersion.substackVersionMeta?.serverHtmlBlob?.htmlContent ?? null;
      clientHtml = postVersion.substackVersionMeta?.clientHtmlBlob?.htmlContent ?? null;
      break;
    case "WIKIPEDIA":
      serverHtml = postVersion.wikipediaVersionMeta?.serverHtmlBlob?.htmlContent ?? null;
      clientHtml = postVersion.wikipediaVersionMeta?.clientHtmlBlob?.htmlContent ?? null;
      break;
    case "X":
      serverHtml = null;
      clientHtml = null;
      break;
    default:
      return unreachablePlatform(post.platform);
  }

  if (postVersion.serverVerifiedAt !== null) {
    if (serverHtml === null) {
      throw new Error(
        `serverVerifiedAt is set but serverHtml is missing for platform ${post.platform} — violates DB invariant (serverVerifiedAt IS NOT NULL → serverHtmlBlobId IS NOT NULL)`,
      );
    }
    return { serverVerifiedAt: postVersion.serverVerifiedAt, serverHtml, clientHtml };
  }
  return { serverVerifiedAt: null, serverHtml, clientHtml };
}

export function toPromptPostContext(postVersion: InvestigationVersionContext): PromptPostContext {
  const post = postVersion.post;
  const authorName = post.author?.displayName;
  const imageOccurrences = postVersion.imageOccurrenceSet.occurrences.map((occurrence) => ({
    originalIndex: occurrence.originalIndex,
    normalizedTextOffset: occurrence.normalizedTextOffset,
    sourceUrl: occurrence.sourceUrl,
    ...(occurrence.captionText === null ? {} : { captionText: occurrence.captionText }),
  }));

  switch (post.platform) {
    case "LESSWRONG": {
      const publishedAt = postVersion.lesswrongVersionMeta?.publishedAt;
      return {
        platform: "LESSWRONG",
        url: post.url,
        ...(authorName != null && { authorName }),
        ...(publishedAt != null && { postPublishedAt: publishedAt.toISOString() }),
        imageOccurrences,
        hasVideo: false,
      };
    }
    case "X": {
      const postedAt = postVersion.xVersionMeta?.postedAt;
      const mediaUrls = postVersion.xVersionMeta?.mediaUrls ?? [];
      const hasVideo = hasXVideoMedia(mediaUrls);
      return {
        platform: "X",
        url: post.url,
        ...(authorName != null && { authorName }),
        ...(postedAt != null && { postPublishedAt: postedAt.toISOString() }),
        imageOccurrences,
        hasVideo,
      };
    }
    case "SUBSTACK": {
      const publishedAt = postVersion.substackVersionMeta?.publishedAt;
      return {
        platform: "SUBSTACK",
        url: post.url,
        ...(authorName != null && { authorName }),
        ...(publishedAt != null && { postPublishedAt: publishedAt.toISOString() }),
        imageOccurrences,
        hasVideo: false,
      };
    }
    case "WIKIPEDIA": {
      const lastModifiedAt = postVersion.wikipediaVersionMeta?.lastModifiedAt;
      return {
        platform: "WIKIPEDIA",
        url: post.url,
        ...(authorName != null && { authorName }),
        ...(lastModifiedAt != null && {
          postPublishedAt: lastModifiedAt.toISOString(),
        }),
        imageOccurrences,
        hasVideo: false,
      };
    }
    default:
      return unreachablePlatform(post.platform);
  }
}
