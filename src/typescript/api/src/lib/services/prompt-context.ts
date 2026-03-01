import type { Platform } from "@openerrata/shared";
import type { Prisma } from "$lib/generated/prisma/client";

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
      contentBlob: {
        select: {
          contentText: true,
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
      post: {
        select: {
          platform: true,
          url: true,
          author: { select: { displayName: true } },
          lesswrongMeta: { select: { publishedAt: true } },
          xMeta: { select: { postedAt: true, mediaUrls: true } },
          substackMeta: { select: { publishedAt: true } },
          wikipediaMeta: { select: { lastModifiedAt: true, imageUrls: true } },
        },
      },
    },
  },
} satisfies Prisma.InvestigationInclude;

type InvestigationWithContext = Prisma.InvestigationGetPayload<{
  include: typeof investigationContextInclude;
}>;
type InvestigationVersionContext = InvestigationWithContext["postVersion"];

export function unreachablePlatform(platform: never): never {
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
  let hasVideo = false;

  for (const mediaUrl of mediaUrls) {
    if (isLikelyVideoUrl(mediaUrl)) {
      hasVideo = true;
      break;
    }
  }

  return hasVideo;
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
      const publishedAt = post.lesswrongMeta?.publishedAt;
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
      const postedAt = post.xMeta?.postedAt;
      const hasVideo = hasXVideoMedia(post.xMeta?.mediaUrls ?? []);
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
      const publishedAt = post.substackMeta?.publishedAt;
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
      const lastModifiedAt = post.wikipediaMeta?.lastModifiedAt;
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
