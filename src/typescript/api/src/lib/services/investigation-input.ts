/**
 * The immutable InvestigationInput snapshot (SPEC §2.4.4, §2.12).
 *
 * Everything the worker hands the investigator that could change after an
 * investigation is queued — rendered markdown, the source URL behind each
 * markdown image placeholder, and the post's URL, author and publication time
 * — is captured here once, when the investigation row is created. Every
 * attempt then runs on exactly the same input, whatever happens to the live
 * Post and version-metadata rows afterwards.
 */

import type { ContentProvenance, Platform } from "@openerrata/shared";
import type { DbClient } from "$lib/db/client";
import type { Prisma } from "$lib/db/prisma-client";
import { resolveMarkdownForInvestigation, type HtmlSnapshots } from "./markdown-resolution.js";

export interface InvestigationInputSnapshot {
  provenance: ContentProvenance;
  contentHash: string;
  markdown:
    | { source: "NONE" }
    | {
        source: "SERVER_HTML" | "CLIENT_HTML";
        markdown: string;
        rendererVersion: string;
        /** Source URL of the image behind `[IMAGE:N]`, indexed by N. */
        imageSourceUrls: string[];
      };
  postUrl: string;
  authorName: string | null;
  postPublishedAt: Date | null;
  hasVideo: boolean;
}

const postVersionForInputSnapshotSelect = {
  serverVerifiedAt: true,
  contentBlob: { select: { contentHash: true } },
  post: {
    select: {
      platform: true,
      url: true,
      author: { select: { displayName: true } },
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
} satisfies Prisma.PostVersionSelect;

type PostVersionForInputSnapshot = Prisma.PostVersionGetPayload<{
  select: typeof postVersionForInputSnapshotSelect;
}>;

function unreachablePlatform(platform: never): never {
  throw new Error(`Unsupported post platform: ${String(platform)}`);
}

const VIDEO_PATH_SUFFIXES = [".mp4", ".webm", ".m3u8", ".mov", ".m4v"] as const;

/** Whether a media URL points at a video file, judged by its path extension. */
export function isLikelyVideoUrl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  return VIDEO_PATH_SUFFIXES.some((suffix) => pathname.endsWith(suffix));
}

interface PlatformInputFields {
  htmlSnapshots: HtmlSnapshots;
  postPublishedAt: Date | null;
  hasVideo: boolean;
}

function htmlSnapshots(
  serverVerifiedAt: Date | null,
  serverHtml: string | null,
  clientHtml: string | null,
  platform: Platform,
): HtmlSnapshots {
  if (serverVerifiedAt === null) {
    return { serverVerifiedAt: null, serverHtml, clientHtml };
  }
  if (serverHtml === null) {
    throw new Error(
      `serverVerifiedAt is set but serverHtml is missing for platform ${platform} — violates DB invariant (serverVerifiedAt IS NOT NULL → serverHtmlBlobId IS NOT NULL)`,
    );
  }
  return { serverVerifiedAt, serverHtml, clientHtml };
}

function platformInputFields(postVersion: PostVersionForInputSnapshot): PlatformInputFields {
  const platform = postVersion.post.platform;
  switch (platform) {
    case "LESSWRONG": {
      const meta = postVersion.lesswrongVersionMeta;
      return {
        htmlSnapshots: htmlSnapshots(
          postVersion.serverVerifiedAt,
          meta?.serverHtmlBlob?.htmlContent ?? null,
          meta?.clientHtmlBlob?.htmlContent ?? null,
          platform,
        ),
        postPublishedAt: meta?.publishedAt ?? null,
        hasVideo: false,
      };
    }
    case "X": {
      const meta = postVersion.xVersionMeta;
      return {
        htmlSnapshots: htmlSnapshots(postVersion.serverVerifiedAt, null, null, platform),
        postPublishedAt: meta?.postedAt ?? null,
        hasVideo: (meta?.mediaUrls ?? []).some(isLikelyVideoUrl),
      };
    }
    case "SUBSTACK": {
      const meta = postVersion.substackVersionMeta;
      return {
        htmlSnapshots: htmlSnapshots(
          postVersion.serverVerifiedAt,
          null,
          meta?.clientHtmlBlob?.htmlContent ?? null,
          platform,
        ),
        postPublishedAt: meta?.publishedAt ?? null,
        hasVideo: false,
      };
    }
    case "WIKIPEDIA": {
      const meta = postVersion.wikipediaVersionMeta;
      return {
        htmlSnapshots: htmlSnapshots(
          postVersion.serverVerifiedAt,
          meta?.serverHtmlBlob?.htmlContent ?? null,
          meta?.clientHtmlBlob?.htmlContent ?? null,
          platform,
        ),
        postPublishedAt: meta?.lastModifiedAt ?? null,
        hasVideo: false,
      };
    }
    default:
      return unreachablePlatform(platform);
  }
}

/** Capture the input snapshot for a new investigation of `postVersionId`. */
export async function buildInvestigationInputSnapshot(
  db: DbClient,
  postVersionId: string,
): Promise<InvestigationInputSnapshot> {
  const postVersion = await db.postVersion.findUnique({
    where: { id: postVersionId },
    select: postVersionForInputSnapshotSelect,
  });
  if (postVersion === null) {
    throw new Error(`PostVersion ${postVersionId} not found`);
  }

  const { post } = postVersion;
  const fields = platformInputFields(postVersion);
  const markdown = resolveMarkdownForInvestigation({
    platform: post.platform,
    snapshots: fields.htmlSnapshots,
    postUrl: post.url,
  });

  return {
    provenance: postVersion.serverVerifiedAt === null ? "CLIENT_FALLBACK" : "SERVER_VERIFIED",
    contentHash: postVersion.contentBlob.contentHash,
    markdown:
      markdown.source === "NONE"
        ? { source: "NONE" }
        : {
            source: markdown.source,
            markdown: markdown.markdown,
            rendererVersion: markdown.rendererVersion,
            imageSourceUrls: markdown.imageSourceUrls,
          },
    postUrl: post.url,
    authorName: post.author?.displayName ?? null,
    postPublishedAt: fields.postPublishedAt,
    hasVideo: fields.hasVideo,
  };
}

/** Row data for persisting `snapshot` as the input of `investigationId`. */
export function investigationInputRow(
  investigationId: string,
  snapshot: InvestigationInputSnapshot,
): Prisma.InvestigationInputUncheckedCreateInput {
  return {
    investigationId,
    provenance: snapshot.provenance,
    contentHash: snapshot.contentHash,
    markdownSource: snapshot.markdown.source,
    ...(snapshot.markdown.source === "NONE"
      ? { imagePlaceholderSourceUrls: [] }
      : {
          markdown: snapshot.markdown.markdown,
          markdownRendererVersion: snapshot.markdown.rendererVersion,
          imagePlaceholderSourceUrls: snapshot.markdown.imageSourceUrls,
        }),
    postUrl: snapshot.postUrl,
    authorName: snapshot.authorName,
    postPublishedAt: snapshot.postPublishedAt,
    hasVideo: snapshot.hasVideo,
  };
}
