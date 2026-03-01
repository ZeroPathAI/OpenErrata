/**
 * Content storage pipeline for posts and post versions.
 *
 * Manages the upsert lifecycle for posts, content blobs, image occurrence
 * sets, and post versions. The entry point is `registerObservedVersion`,
 * which normalizes client-observed content, resolves the canonical version
 * (server-verified or client-fallback), and upserts the entire storage chain.
 */

import {
  normalizeContent,
  hashContent,
  validateAndSortImageOccurrences,
  trimToOptionalNonEmpty,
  type Platform,
  type PlatformMetadataByPlatform,
  type ViewPostInput,
} from "@openerrata/shared";
import {
  fetchCanonicalContent,
  lesswrongHtmlToNormalizedText,
} from "$lib/services/content-fetcher.js";
import {
  resolveCanonicalContentVersion,
  type CanonicalContentVersion,
  type ObservedContentVersion,
} from "$lib/services/canonical-resolution.js";
import { wordCount } from "$lib/services/investigation-lifecycle.js";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import { toOptionalDate } from "$lib/date.js";
import type { PrismaClient } from "$lib/generated/prisma/client";
import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { prepareViewPostInput, type PreparedViewPostInput } from "./wikipedia.js";
import type { ExtensionRuntimeErrorCode } from "@openerrata/shared";

type PostMetadataInput = {
  [P in Platform]: {
    postId: string;
    platform: P;
    externalId: string;
    observedImageUrls?: string[];
    metadata: PlatformMetadataByPlatform[P];
  };
}[Platform];

type UpsertPostInput = {
  [P in Platform]: {
    platform: P;
    externalId: string;
    url: string;
    observedImageUrls?: string[];
    metadata: PlatformMetadataByPlatform[P];
  };
}[Platform];

export interface ResolvedPostVersion {
  id: string;
  postId: string;
  versionHash: string;
  contentProvenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
  contentBlob: {
    contentHash: string;
    contentText: string;
    wordCount: number;
  };
  post: {
    id: string;
    platform: Platform;
    externalId: string;
    url: string;
  };
}

const CONTENT_MISMATCH_ERROR_CODE: ExtensionRuntimeErrorCode = "CONTENT_MISMATCH";
const UNIQUE_CONSTRAINT_RACE_RETRY_ATTEMPTS = 30;
const UNIQUE_CONSTRAINT_RACE_RETRY_DELAY_MS = 20;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function contentMismatchError(): TRPCError {
  return new TRPCError({
    code: "BAD_REQUEST",
    message: "Observed content does not match canonical content",
    cause: { openerrataCode: CONTENT_MISMATCH_ERROR_CODE },
  });
}

// ---------------------------------------------------------------------------
// Image occurrence validation
// ---------------------------------------------------------------------------

function validateAndNormalizeImageOccurrences(
  occurrences: ViewPostInput["observedImageOccurrences"],
  contentText: string,
): NonNullable<ViewPostInput["observedImageOccurrences"]> {
  const sorted = validateAndSortImageOccurrences(occurrences, {
    contentTextLength: contentText.length,
    onValidationIssue: (issue): never => {
      switch (issue.code) {
        case "NON_CONTIGUOUS_ORIGINAL_INDEX":
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Observed image occurrences must use contiguous originalIndex values starting at 0",
          });
        case "OFFSET_EXCEEDS_CONTENT_LENGTH":
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Observed image occurrence offset exceeds content length",
          });
        case "DECREASING_NORMALIZED_TEXT_OFFSET":
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Observed image occurrences must be non-decreasing by normalizedTextOffset",
          });
      }
    },
  });

  return sorted.map((occurrence) => {
    const captionText = occurrence.captionText?.trim();
    return {
      originalIndex: occurrence.originalIndex,
      normalizedTextOffset: occurrence.normalizedTextOffset,
      sourceUrl: occurrence.sourceUrl,
      ...(captionText === undefined || captionText.length === 0 ? {} : { captionText }),
    };
  });
}

function imageOccurrencesHash(
  normalizedOccurrences: NonNullable<ViewPostInput["observedImageOccurrences"]>,
): string {
  return sha256(JSON.stringify(normalizedOccurrences));
}

function versionHashFromContentAndImages(contentHash: string, occurrencesHash: string): string {
  return sha256(`${contentHash}\n${occurrencesHash}`);
}

// ---------------------------------------------------------------------------
// Author and metadata linking
// ---------------------------------------------------------------------------

async function upsertAuthorAndAttachToPost(
  prisma: PrismaClient,
  input: {
    postId: string;
    platform: Platform;
    platformUserId: string;
    displayName: string;
  },
): Promise<void> {
  const author = await prisma.author.upsert({
    where: {
      platform_platformUserId: {
        platform: input.platform,
        platformUserId: input.platformUserId,
      },
    },
    create: {
      platform: input.platform,
      platformUserId: input.platformUserId,
      displayName: input.displayName,
    },
    update: {
      displayName: input.displayName,
    },
    select: { id: true },
  });

  await prisma.post.update({
    where: { id: input.postId },
    data: { authorId: author.id },
  });
}

async function linkAuthorAndMetadata(
  prisma: PrismaClient,
  input: PostMetadataInput,
): Promise<void> {
  switch (input.platform) {
    case "LESSWRONG": {
      const authorName = trimToOptionalNonEmpty(input.metadata.authorName);
      const authorSlug = trimToOptionalNonEmpty(input.metadata.authorSlug);
      const authorDisplayName = authorName ?? authorSlug;

      if (authorDisplayName !== undefined && authorDisplayName.length > 0) {
        const platformUserId = authorSlug ?? `name:${authorDisplayName.toLowerCase()}`;
        await upsertAuthorAndAttachToPost(prisma, {
          postId: input.postId,
          platform: "LESSWRONG",
          platformUserId,
          displayName: authorDisplayName,
        });
      }

      const title = input.metadata.title?.trim();
      const htmlContent = input.metadata.htmlContent;
      const metadataAuthorName = authorName ?? authorSlug;

      if (
        title !== undefined &&
        title.length > 0 &&
        metadataAuthorName !== undefined &&
        metadataAuthorName.length > 0
      ) {
        const lesswrongMetaData = {
          slug: input.metadata.slug,
          title,
          htmlContent,
          imageUrls: input.observedImageUrls ?? [],
          authorName: metadataAuthorName,
          authorSlug: authorSlug ?? null,
          tags: input.metadata.tags,
          publishedAt: toOptionalDate(input.metadata.publishedAt),
        };
        await prisma.lesswrongMeta.upsert({
          where: { postId: input.postId },
          create: {
            postId: input.postId,
            ...lesswrongMetaData,
          },
          update: lesswrongMetaData,
        });
      }
      return;
    }
    case "X": {
      const authorHandle = input.metadata.authorHandle;
      const authorDisplayName = trimToOptionalNonEmpty(input.metadata.authorDisplayName);

      await upsertAuthorAndAttachToPost(prisma, {
        postId: input.postId,
        platform: "X",
        platformUserId: authorHandle,
        displayName: authorDisplayName ?? authorHandle,
      });

      const xMetaData = {
        text: input.metadata.text,
        authorHandle,
        authorDisplayName: authorDisplayName ?? null,
        mediaUrls: input.metadata.mediaUrls,
        likeCount: input.metadata.likeCount ?? null,
        retweetCount: input.metadata.retweetCount ?? null,
        postedAt: toOptionalDate(input.metadata.postedAt),
      };
      await prisma.xMeta.upsert({
        where: { tweetId: input.externalId },
        create: {
          postId: input.postId,
          tweetId: input.externalId,
          ...xMetaData,
        },
        update: xMetaData,
      });
      return;
    }
    case "SUBSTACK": {
      const authorName = input.metadata.authorName.trim();
      const authorSubstackHandle = trimToOptionalNonEmpty(input.metadata.authorSubstackHandle);
      const platformUserId =
        authorSubstackHandle ??
        `publication:${input.metadata.publicationSubdomain}:name:${authorName.toLowerCase()}`;

      await upsertAuthorAndAttachToPost(prisma, {
        postId: input.postId,
        platform: "SUBSTACK",
        platformUserId,
        displayName: authorName,
      });

      const substackMetaData = {
        substackPostId: input.metadata.substackPostId,
        publicationSubdomain: input.metadata.publicationSubdomain,
        slug: input.metadata.slug,
        title: input.metadata.title,
        subtitle: input.metadata.subtitle ?? null,
        imageUrls: input.observedImageUrls ?? [],
        authorName,
        authorSubstackHandle: authorSubstackHandle ?? null,
        publishedAt: toOptionalDate(input.metadata.publishedAt),
        likeCount: input.metadata.likeCount ?? null,
        commentCount: input.metadata.commentCount ?? null,
      };
      await prisma.substackMeta.upsert({
        where: { postId: input.postId },
        create: {
          postId: input.postId,
          ...substackMetaData,
        },
        update: substackMetaData,
      });
      return;
    }
    case "WIKIPEDIA": {
      const wikipediaMetaData = {
        pageId: input.metadata.pageId,
        language: input.metadata.language,
        title: input.metadata.title,
        displayTitle: input.metadata.displayTitle ?? null,
        revisionId: input.metadata.revisionId,
        lastModifiedAt: toOptionalDate(input.metadata.lastModifiedAt),
        imageUrls: input.observedImageUrls ?? [],
      };
      await prisma.wikipediaMeta.upsert({
        where: { postId: input.postId },
        create: {
          postId: input.postId,
          ...wikipediaMetaData,
        },
        update: wikipediaMetaData,
      });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Post upsert
// ---------------------------------------------------------------------------

async function upsertPost(prisma: PrismaClient, input: UpsertPostInput) {
  const post = await prisma.post.upsert({
    where: {
      platform_externalId: {
        platform: input.platform,
        externalId: input.externalId,
      },
    },
    create: {
      platform: input.platform,
      externalId: input.externalId,
      url: input.url,
    },
    update: {
      url: input.url,
    },
  });

  await linkAuthorAndMetadata(prisma, {
    postId: post.id,
    ...input,
  });

  return post;
}

async function upsertPostFromViewInput(prisma: PrismaClient, input: PreparedViewPostInput) {
  const commonInput = {
    url: input.url,
    ...(input.observedImageUrls !== undefined && { observedImageUrls: input.observedImageUrls }),
  };

  if (input.platform === "LESSWRONG") {
    return upsertPost(prisma, {
      ...commonInput,
      platform: "LESSWRONG",
      externalId: input.externalId,
      metadata: input.metadata,
    });
  }

  if (input.platform === "X") {
    return upsertPost(prisma, {
      ...commonInput,
      platform: "X",
      externalId: input.externalId,
      metadata: input.metadata,
    });
  }

  if (input.platform === "WIKIPEDIA") {
    return upsertPost(prisma, {
      ...commonInput,
      platform: "WIKIPEDIA",
      externalId: input.derivedExternalId,
      metadata: input.metadata,
    });
  }

  return upsertPost(prisma, {
    ...commonInput,
    platform: "SUBSTACK",
    externalId: input.externalId,
    metadata: input.metadata,
  });
}

// ---------------------------------------------------------------------------
// Content blob and image occurrence set management
// ---------------------------------------------------------------------------

function normalizedOccurrenceToData(
  normalizedOccurrences: NonNullable<ViewPostInput["observedImageOccurrences"]>,
) {
  return normalizedOccurrences.map((occurrence) => ({
    originalIndex: occurrence.originalIndex,
    normalizedTextOffset: occurrence.normalizedTextOffset,
    sourceUrl: occurrence.sourceUrl,
    captionText: occurrence.captionText ?? null,
  }));
}

function hasSameNormalizedOccurrences(
  stored: {
    originalIndex: number;
    normalizedTextOffset: number;
    sourceUrl: string;
    captionText: string | null;
  }[],
  normalized: NonNullable<ViewPostInput["observedImageOccurrences"]>,
): boolean {
  if (stored.length !== normalized.length) {
    return false;
  }

  for (let index = 0; index < stored.length; index += 1) {
    const a = stored[index];
    const b = normalized[index];
    if (a === undefined || b === undefined) {
      return false;
    }
    if (
      a.originalIndex !== b.originalIndex ||
      a.normalizedTextOffset !== b.normalizedTextOffset ||
      a.sourceUrl !== b.sourceUrl ||
      a.captionText !== (b.captionText ?? null)
    ) {
      return false;
    }
  }

  return true;
}

async function createOrFindByUniqueConstraint<T>(input: {
  findExisting: () => Promise<T | null>;
  create: () => Promise<T>;
  assertEquivalent: (existing: T) => void;
}): Promise<T> {
  const existing = await input.findExisting();
  if (existing !== null) {
    input.assertEquivalent(existing);
    return existing;
  }

  try {
    return await input.create();
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    // In concurrent transactions, the winning insert can briefly be invisible
    // to this transaction right after a unique-constraint conflict.
    for (let attempt = 0; attempt < UNIQUE_CONSTRAINT_RACE_RETRY_ATTEMPTS; attempt += 1) {
      const raced = await input.findExisting();
      if (raced !== null) {
        input.assertEquivalent(raced);
        return raced;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, UNIQUE_CONSTRAINT_RACE_RETRY_DELAY_MS);
      });
    }
    throw error;
  }
}

async function getOrCreateContentBlob(
  prisma: PrismaClient,
  input: {
    contentHash: string;
    contentText: string;
  },
) {
  return createOrFindByUniqueConstraint({
    findExisting: () =>
      prisma.contentBlob.findUnique({
        where: { contentHash: input.contentHash },
      }),
    create: () =>
      prisma.contentBlob.create({
        data: {
          contentHash: input.contentHash,
          contentText: input.contentText,
          wordCount: wordCount(input.contentText),
        },
      }),
    assertEquivalent: (existing) => {
      if (existing.contentText !== input.contentText) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `contentHash collision for ${input.contentHash}`,
        });
      }
    },
  });
}

async function findImageOccurrenceSetByHash(prisma: PrismaClient, occurrencesHash: string) {
  return prisma.imageOccurrenceSet.findUnique({
    where: { occurrencesHash },
    include: {
      occurrences: {
        orderBy: [{ originalIndex: "asc" }],
      },
    },
  });
}

async function createImageOccurrenceSet(input: {
  prisma: PrismaClient;
  occurrencesHash: string;
  normalizedOccurrences: NonNullable<ViewPostInput["observedImageOccurrences"]>;
}) {
  return input.prisma.imageOccurrenceSet.create({
    data: {
      occurrencesHash: input.occurrencesHash,
      ...(input.normalizedOccurrences.length === 0
        ? {}
        : {
            occurrences: {
              create: normalizedOccurrenceToData(input.normalizedOccurrences),
            },
          }),
    },
    include: {
      occurrences: {
        orderBy: [{ originalIndex: "asc" }],
      },
    },
  });
}

function assertOccurrenceSetMatches(input: {
  occurrencesHash: string;
  normalizedOccurrences: NonNullable<ViewPostInput["observedImageOccurrences"]>;
  existing: {
    occurrences: {
      originalIndex: number;
      normalizedTextOffset: number;
      sourceUrl: string;
      captionText: string | null;
    }[];
  };
}): void {
  if (!hasSameNormalizedOccurrences(input.existing.occurrences, input.normalizedOccurrences)) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `image occurrence hash collision for ${input.occurrencesHash}`,
    });
  }
}

async function getOrCreateImageOccurrenceSet(
  prisma: PrismaClient,
  normalizedOccurrences: NonNullable<ViewPostInput["observedImageOccurrences"]>,
) {
  const occurrencesHash = imageOccurrencesHash(normalizedOccurrences);

  return createOrFindByUniqueConstraint({
    findExisting: () => findImageOccurrenceSetByHash(prisma, occurrencesHash),
    create: () =>
      createImageOccurrenceSet({
        prisma,
        occurrencesHash,
        normalizedOccurrences,
      }),
    assertEquivalent: (existing) =>
      assertOccurrenceSetMatches({
        occurrencesHash,
        normalizedOccurrences,
        existing,
      }),
  });
}

// ---------------------------------------------------------------------------
// Post version upsert
// ---------------------------------------------------------------------------

async function upsertPostVersion(
  prisma: PrismaClient,
  input: {
    postId: string;
    canonical: CanonicalContentVersion;
    observedImageOccurrences?: ViewPostInput["observedImageOccurrences"];
  },
): Promise<ResolvedPostVersion> {
  const normalizedOccurrences = validateAndNormalizeImageOccurrences(
    input.observedImageOccurrences,
    input.canonical.contentText,
  );

  const contentBlob = await getOrCreateContentBlob(prisma, {
    contentHash: input.canonical.contentHash,
    contentText: input.canonical.contentText,
  });

  const occurrenceSet = await getOrCreateImageOccurrenceSet(prisma, normalizedOccurrences);

  const versionHash = versionHashFromContentAndImages(
    contentBlob.contentHash,
    occurrenceSet.occurrencesHash,
  );

  const now = new Date();
  const postVersionSelect = {
    id: true,
    postId: true,
    versionHash: true,
    contentProvenance: true,
    contentBlob: {
      select: {
        contentHash: true,
        contentText: true,
        wordCount: true,
      },
    },
    post: {
      select: {
        id: true,
        platform: true,
        externalId: true,
        url: true,
      },
    },
  } as const;
  const updateLastSeenData = {
    lastSeenAt: now,
    seenCount: {
      increment: 1,
    },
  };

  let postVersion: ResolvedPostVersion;
  try {
    postVersion = await prisma.postVersion.upsert({
      where: {
        postId_versionHash: {
          postId: input.postId,
          versionHash,
        },
      },
      create: {
        postId: input.postId,
        versionHash,
        contentBlobId: contentBlob.id,
        imageOccurrenceSetId: occurrenceSet.id,
        contentProvenance: input.canonical.provenance,
        fetchFailureReason:
          input.canonical.provenance === "CLIENT_FALLBACK"
            ? input.canonical.fetchFailureReason
            : null,
        serverVerifiedAt: input.canonical.provenance === "SERVER_VERIFIED" ? now : null,
        firstSeenAt: now,
        lastSeenAt: now,
        seenCount: 1,
      },
      update: updateLastSeenData,
      select: postVersionSelect,
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    postVersion = await prisma.postVersion.update({
      where: {
        postId_versionHash: {
          postId: input.postId,
          versionHash,
        },
      },
      data: updateLastSeenData,
      select: postVersionSelect,
    });
  }

  if (
    input.canonical.provenance === "SERVER_VERIFIED" &&
    postVersion.contentProvenance === "CLIENT_FALLBACK"
  ) {
    postVersion = await prisma.postVersion.update({
      where: { id: postVersion.id },
      data: {
        contentProvenance: "SERVER_VERIFIED",
        fetchFailureReason: null,
        serverVerifiedAt: now,
      },
      select: postVersionSelect,
    });
  }

  return postVersion;
}

// ---------------------------------------------------------------------------
// Post version lookup
// ---------------------------------------------------------------------------

export async function findPostVersionById(
  prisma: PrismaClient,
  postVersionId: string,
): Promise<ResolvedPostVersion | null> {
  return prisma.postVersion.findUnique({
    where: { id: postVersionId },
    select: {
      id: true,
      postId: true,
      versionHash: true,
      contentProvenance: true,
      contentBlob: {
        select: {
          contentHash: true,
          contentText: true,
          wordCount: true,
        },
      },
      post: {
        select: {
          id: true,
          platform: true,
          externalId: true,
          url: true,
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Observed content normalization
// ---------------------------------------------------------------------------

async function toObservedContentVersion(input: ViewPostInput): Promise<ObservedContentVersion> {
  const contentText =
    input.platform === "LESSWRONG"
      ? lesswrongHtmlToNormalizedText(input.metadata.htmlContent)
      : normalizeContent(input.observedContentText);
  const contentHash = await hashContent(contentText);
  return { contentText, contentHash };
}

// ---------------------------------------------------------------------------
// Main entry point: registerObservedVersion
// ---------------------------------------------------------------------------

/**
 * Normalizes client-observed content, resolves the canonical version
 * (server-verified when a live fetch matches; client-fallback otherwise),
 * and upserts the full Post -> PostVersion -> ContentBlob storage chain.
 */
export async function registerObservedVersion(
  prisma: PrismaClient,
  input: ViewPostInput,
): Promise<ResolvedPostVersion> {
  const preparedInput = prepareViewPostInput(input);
  const observed = await toObservedContentVersion(preparedInput);

  const canonicalResolution = await resolveCanonicalContentVersion({
    viewInput: preparedInput,
    observed,
    fetchCanonicalContent,
  });
  if (canonicalResolution.state === "CONTENT_MISMATCH") {
    throw contentMismatchError();
  }

  const post = await upsertPostFromViewInput(prisma, preparedInput);

  return upsertPostVersion(prisma, {
    postId: post.id,
    canonical: canonicalResolution.canonical,
    ...(preparedInput.observedImageOccurrences === undefined
      ? {}
      : { observedImageOccurrences: preparedInput.observedImageOccurrences }),
  });
}
