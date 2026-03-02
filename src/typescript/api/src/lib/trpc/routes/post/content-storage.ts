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
  type ServerVerifiedContentMismatch,
} from "$lib/services/canonical-resolution.js";
import { wordCount } from "$lib/services/investigation-lifecycle.js";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import { toOptionalDate } from "$lib/date.js";
import type { PrismaClient, Prisma } from "$lib/generated/prisma/client";
import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { prepareViewPostInput, type PreparedViewPostInput } from "./wikipedia.js";

type UpsertPostInput = {
  [P in Platform]: {
    platform: P;
    externalId: string;
    url: string;
    metadata: PlatformMetadataByPlatform[P];
  };
}[Platform];

export interface ResolvedPostVersion {
  id: string;
  postId: string;
  versionHash: string;
  serverVerifiedAt: Date | null;
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

const UNIQUE_CONSTRAINT_RACE_RETRY_ATTEMPTS = 30;
const UNIQUE_CONSTRAINT_RACE_RETRY_DELAY_MS = 20;
type DbClient = PrismaClient | Prisma.TransactionClient;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function logServerVerifiedContentMismatch(mismatch: ServerVerifiedContentMismatch): void {
  const identity =
    mismatch.externalId === undefined
      ? mismatch.url
      : `externalId=${mismatch.externalId}; url=${mismatch.url}`;

  console.error(
    `Canonical integrity mismatch for ${mismatch.platform}; continuing with server-verified content. ${identity}; observedHash=${mismatch.observedHash}; serverHash=${mismatch.serverHash}`,
  );
}

function applyServerVerifiedWikipediaIdentity(input: {
  preparedInput: PreparedViewPostInput;
  canonical: CanonicalContentVersion;
}): PreparedViewPostInput {
  if (
    input.preparedInput.platform !== "WIKIPEDIA" ||
    input.canonical.provenance !== "SERVER_VERIFIED" ||
    input.canonical.canonicalIdentity?.platform !== "WIKIPEDIA"
  ) {
    return input.preparedInput;
  }

  const serverIdentity = input.canonical.canonicalIdentity;
  if (serverIdentity.language !== input.preparedInput.metadata.language) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Wikipedia canonical identity language mismatch between verified fetch and prepared input",
    });
  }

  if (serverIdentity.pageId === input.preparedInput.metadata.pageId) {
    return input.preparedInput;
  }

  console.error(
    `Wikipedia metadata identity mismatch; continuing with server-verified page identity. url=${input.preparedInput.url}; clientPageId=${input.preparedInput.metadata.pageId}; serverPageId=${serverIdentity.pageId}`,
  );

  return {
    ...input.preparedInput,
    metadata: {
      ...input.preparedInput.metadata,
      pageId: serverIdentity.pageId,
      revisionId: serverIdentity.revisionId,
    },
    derivedExternalId: `${serverIdentity.language}:${serverIdentity.pageId}`,
  };
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
  prisma: DbClient,
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

/**
 * Upsert the Author record for a post and link it via Post.authorId.
 * Extracted from the deleted linkAuthorAndMetadata; handles only author
 * identity — platform-specific metadata lives in version meta tables.
 */
async function upsertAuthorForPost(
  prisma: DbClient,
  input: { postId: string } & UpsertPostInput,
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
      return;
    }
    case "WIKIPEDIA":
      return;
  }
}

// ---------------------------------------------------------------------------
// Post upsert
// ---------------------------------------------------------------------------

async function upsertPost(prisma: DbClient, input: UpsertPostInput) {
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

  await upsertAuthorForPost(prisma, {
    postId: post.id,
    ...input,
  });

  return post;
}

async function upsertPostFromViewInput(prisma: DbClient, input: PreparedViewPostInput) {
  if (input.platform === "LESSWRONG") {
    return upsertPost(prisma, {
      url: input.url,
      platform: "LESSWRONG",
      externalId: input.externalId,
      metadata: input.metadata,
    });
  }

  if (input.platform === "X") {
    return upsertPost(prisma, {
      url: input.url,
      platform: "X",
      externalId: input.externalId,
      metadata: input.metadata,
    });
  }

  if (input.platform === "WIKIPEDIA") {
    return upsertPost(prisma, {
      url: input.url,
      platform: "WIKIPEDIA",
      externalId: input.derivedExternalId,
      metadata: input.metadata,
    });
  }

  return upsertPost(prisma, {
    url: input.url,
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
  /**
   * Safe only outside of interactive transactions.
   * Inside a transaction, unique violations abort the transaction until rollback.
   */
  retryReadAfterUniqueConflict?: boolean;
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
    if (input.retryReadAfterUniqueConflict !== true) {
      throw error;
    }
    // For non-transactional callers, the winning insert can briefly be
    // invisible right after a unique-constraint conflict.
    for (let attempt = 0; attempt < UNIQUE_CONSTRAINT_RACE_RETRY_ATTEMPTS; attempt += 1) {
      const raced = await input.findExisting();
      if (raced !== null) {
        input.assertEquivalent(raced);
        return raced;
      }
      await delay(UNIQUE_CONSTRAINT_RACE_RETRY_DELAY_MS);
    }
    throw error;
  }
}

async function getOrCreateContentBlob(
  prisma: DbClient,
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

async function findImageOccurrenceSetByHash(prisma: DbClient, occurrencesHash: string) {
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
  prisma: DbClient;
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
  prisma: DbClient,
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
// HTML blob management
// ---------------------------------------------------------------------------

async function getOrCreateHtmlBlob(
  prisma: DbClient,
  html: string,
): Promise<{ id: string; htmlHash: string }> {
  const htmlHash = sha256(html);
  return createOrFindByUniqueConstraint({
    findExisting: () =>
      prisma.htmlBlob.findUnique({
        where: { htmlHash },
        select: { id: true, htmlHash: true },
      }),
    create: () =>
      prisma.htmlBlob.create({
        data: { htmlHash, htmlContent: html },
        select: { id: true, htmlHash: true },
      }),
    assertEquivalent: () => {
      // Content-addressed: same hash means same content.
    },
  });
}

// ---------------------------------------------------------------------------
// Post version upsert
// ---------------------------------------------------------------------------

async function upsertPostVersion(
  prisma: DbClient,
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
    serverVerifiedAt: true,
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

  const postVersion = await prisma.postVersion.upsert({
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
      serverVerifiedAt: input.canonical.provenance === "SERVER_VERIFIED" ? now : null,
      firstSeenAt: now,
      lastSeenAt: now,
      seenCount: 1,
    },
    update: updateLastSeenData,
    select: postVersionSelect,
  });

  // One-way latch: if we now have server verification but the PostVersion
  // was originally created as CLIENT_FALLBACK, set serverVerifiedAt.
  // The DB trigger prevents overwriting an existing non-null value.
  if (input.canonical.provenance === "SERVER_VERIFIED" && postVersion.serverVerifiedAt === null) {
    return prisma.postVersion.update({
      where: { id: postVersion.id },
      data: { serverVerifiedAt: now },
      select: postVersionSelect,
    });
  }

  return postVersion;
}

function assertNoServerHtmlConflict(input: {
  platform: Platform;
  postVersionId: string;
  existingHtmlBlobId: string | null;
  incomingHtmlBlobId: string | null;
}): void {
  // Only enforce immutability for server-fetched HTML. Client HTML is extracted
  // from the live DOM on each visit, so dynamic page elements (timestamps, view
  // counts, JS-rendered content) can produce a different blob for the same
  // PostVersion. The first-write-wins guard below each call site handles that
  // case correctly without treating it as an error.
  if (
    input.existingHtmlBlobId !== null &&
    input.incomingHtmlBlobId !== null &&
    input.existingHtmlBlobId !== input.incomingHtmlBlobId
  ) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `${input.platform} server HTML snapshot mismatch for postVersion ${input.postVersionId}: existing=${input.existingHtmlBlobId}, incoming=${input.incomingHtmlBlobId}`,
    });
  }
}

async function createPlatformVersionMetadataIfMissing(
  prisma: DbClient,
  input: {
    preparedInput: PreparedViewPostInput;
    postVersionId: string;
    htmlBlobIds: {
      serverHtmlBlobId: string | null;
      clientHtmlBlobId: string | null;
    };
  },
): Promise<void> {
  switch (input.preparedInput.platform) {
    case "LESSWRONG": {
      const metadata = input.preparedInput.metadata;
      const { serverHtmlBlobId, clientHtmlBlobId } = input.htmlBlobIds;
      if (serverHtmlBlobId === null && clientHtmlBlobId === null) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `LessWrong version requires at least one HTML snapshot (postVersionId=${input.postVersionId})`,
        });
      }
      const title = trimToOptionalNonEmpty(metadata.title);
      const authorName = trimToOptionalNonEmpty(metadata.authorName);
      const authorSlug = trimToOptionalNonEmpty(metadata.authorSlug);

      const existingOrCreated = await createOrFindByUniqueConstraint({
        findExisting: () =>
          prisma.lesswrongVersionMeta.findUnique({
            where: { postVersionId: input.postVersionId },
            select: {
              slug: true,
              serverHtmlBlobId: true,
              clientHtmlBlobId: true,
            },
          }),
        create: () =>
          prisma.lesswrongVersionMeta.create({
            data: {
              postVersionId: input.postVersionId,
              slug: metadata.slug,
              ...(title !== undefined && { title }),
              ...(serverHtmlBlobId !== null && { serverHtmlBlobId }),
              ...(clientHtmlBlobId !== null && { clientHtmlBlobId }),
              imageUrls: input.preparedInput.observedImageUrls ?? [],
              ...(authorName !== undefined && { authorName }),
              ...(authorSlug !== undefined && { authorSlug }),
              tags: metadata.tags,
              publishedAt: toOptionalDate(metadata.publishedAt),
            },
            select: {
              slug: true,
              serverHtmlBlobId: true,
              clientHtmlBlobId: true,
            },
          }),
        assertEquivalent: (existing) => {
          if (existing.slug !== metadata.slug) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `LessWrong version slug mismatch for postVersion ${input.postVersionId}: existing=${existing.slug}, incoming=${metadata.slug}`,
            });
          }
          assertNoServerHtmlConflict({
            platform: "LESSWRONG",
            postVersionId: input.postVersionId,
            existingHtmlBlobId: existing.serverHtmlBlobId,
            incomingHtmlBlobId: serverHtmlBlobId,
          });
        },
      });
      await Promise.all([
        serverHtmlBlobId !== null && existingOrCreated.serverHtmlBlobId === null
          ? prisma.lesswrongVersionMeta.updateMany({
              where: { postVersionId: input.postVersionId, serverHtmlBlobId: null },
              data: { serverHtmlBlobId },
            })
          : null,
        clientHtmlBlobId !== null && existingOrCreated.clientHtmlBlobId === null
          ? prisma.lesswrongVersionMeta.updateMany({
              where: { postVersionId: input.postVersionId, clientHtmlBlobId: null },
              data: { clientHtmlBlobId },
            })
          : null,
      ]);
      return;
    }
    case "X": {
      const metadata = input.preparedInput.metadata;
      const tweetId = input.preparedInput.externalId;
      const authorDisplayName = trimToOptionalNonEmpty(metadata.authorDisplayName);
      await createOrFindByUniqueConstraint({
        findExisting: () =>
          prisma.xVersionMeta.findUnique({
            where: { postVersionId: input.postVersionId },
            select: { tweetId: true },
          }),
        create: () =>
          prisma.xVersionMeta.create({
            data: {
              postVersionId: input.postVersionId,
              tweetId,
              text: metadata.text,
              authorHandle: metadata.authorHandle,
              authorDisplayName: authorDisplayName ?? null,
              mediaUrls: metadata.mediaUrls,
              likeCount: metadata.likeCount ?? null,
              retweetCount: metadata.retweetCount ?? null,
              postedAt: toOptionalDate(metadata.postedAt),
            },
            select: { tweetId: true },
          }),
        assertEquivalent: (existing) => {
          if (existing.tweetId !== tweetId) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `X version tweetId mismatch for postVersion ${input.postVersionId}: existing=${existing.tweetId}, incoming=${tweetId}`,
            });
          }
        },
      });
      return;
    }
    case "SUBSTACK": {
      const metadata = input.preparedInput.metadata;
      const { serverHtmlBlobId, clientHtmlBlobId } = input.htmlBlobIds;
      const authorSubstackHandle = trimToOptionalNonEmpty(metadata.authorSubstackHandle);

      const existingOrCreated = await createOrFindByUniqueConstraint({
        findExisting: () =>
          prisma.substackVersionMeta.findUnique({
            where: { postVersionId: input.postVersionId },
            select: {
              substackPostId: true,
              serverHtmlBlobId: true,
              clientHtmlBlobId: true,
            },
          }),
        create: () =>
          prisma.substackVersionMeta.create({
            data: {
              postVersionId: input.postVersionId,
              substackPostId: metadata.substackPostId,
              publicationSubdomain: metadata.publicationSubdomain,
              slug: metadata.slug,
              title: metadata.title,
              subtitle: metadata.subtitle ?? null,
              ...(serverHtmlBlobId !== null && { serverHtmlBlobId }),
              ...(clientHtmlBlobId !== null && { clientHtmlBlobId }),
              imageUrls: input.preparedInput.observedImageUrls ?? [],
              authorName: metadata.authorName,
              authorSubstackHandle: authorSubstackHandle ?? null,
              publishedAt: toOptionalDate(metadata.publishedAt),
              likeCount: metadata.likeCount ?? null,
              commentCount: metadata.commentCount ?? null,
            },
            select: {
              substackPostId: true,
              serverHtmlBlobId: true,
              clientHtmlBlobId: true,
            },
          }),
        assertEquivalent: (existing) => {
          if (existing.substackPostId !== metadata.substackPostId) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `Substack version post id mismatch for postVersion ${input.postVersionId}: existing=${existing.substackPostId}, incoming=${metadata.substackPostId}`,
            });
          }
          assertNoServerHtmlConflict({
            platform: "SUBSTACK",
            postVersionId: input.postVersionId,
            existingHtmlBlobId: existing.serverHtmlBlobId,
            incomingHtmlBlobId: serverHtmlBlobId,
          });
        },
      });
      await Promise.all([
        serverHtmlBlobId !== null && existingOrCreated.serverHtmlBlobId === null
          ? prisma.substackVersionMeta.updateMany({
              where: { postVersionId: input.postVersionId, serverHtmlBlobId: null },
              data: { serverHtmlBlobId },
            })
          : null,
        clientHtmlBlobId !== null && existingOrCreated.clientHtmlBlobId === null
          ? prisma.substackVersionMeta.updateMany({
              where: { postVersionId: input.postVersionId, clientHtmlBlobId: null },
              data: { clientHtmlBlobId },
            })
          : null,
      ]);
      return;
    }
    case "WIKIPEDIA": {
      const metadata = input.preparedInput.metadata;
      const { serverHtmlBlobId, clientHtmlBlobId } = input.htmlBlobIds;

      const existingOrCreated = await createOrFindByUniqueConstraint({
        findExisting: () =>
          prisma.wikipediaVersionMeta.findUnique({
            where: { postVersionId: input.postVersionId },
            select: {
              revisionId: true,
              serverHtmlBlobId: true,
              clientHtmlBlobId: true,
            },
          }),
        create: () =>
          prisma.wikipediaVersionMeta.create({
            data: {
              postVersionId: input.postVersionId,
              pageId: metadata.pageId,
              language: metadata.language,
              title: metadata.title,
              displayTitle: metadata.displayTitle ?? null,
              ...(serverHtmlBlobId !== null && { serverHtmlBlobId }),
              ...(clientHtmlBlobId !== null && { clientHtmlBlobId }),
              revisionId: metadata.revisionId,
              lastModifiedAt: toOptionalDate(metadata.lastModifiedAt),
              imageUrls: input.preparedInput.observedImageUrls ?? [],
            },
            select: {
              revisionId: true,
              serverHtmlBlobId: true,
              clientHtmlBlobId: true,
            },
          }),
        assertEquivalent: (existing) => {
          if (existing.revisionId !== metadata.revisionId) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `Wikipedia version revision mismatch for postVersion ${input.postVersionId}: existing=${existing.revisionId}, incoming=${metadata.revisionId}`,
            });
          }
          assertNoServerHtmlConflict({
            platform: "WIKIPEDIA",
            postVersionId: input.postVersionId,
            existingHtmlBlobId: existing.serverHtmlBlobId,
            incomingHtmlBlobId: serverHtmlBlobId,
          });
        },
      });
      await Promise.all([
        serverHtmlBlobId !== null && existingOrCreated.serverHtmlBlobId === null
          ? prisma.wikipediaVersionMeta.updateMany({
              where: { postVersionId: input.postVersionId, serverHtmlBlobId: null },
              data: { serverHtmlBlobId },
            })
          : null,
        clientHtmlBlobId !== null && existingOrCreated.clientHtmlBlobId === null
          ? prisma.wikipediaVersionMeta.updateMany({
              where: { postVersionId: input.postVersionId, clientHtmlBlobId: null },
              data: { clientHtmlBlobId },
            })
          : null,
      ]);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Post version lookup
// ---------------------------------------------------------------------------

export async function findPostVersionById(
  prisma: DbClient,
  postVersionId: string,
): Promise<ResolvedPostVersion | null> {
  return prisma.postVersion.findUnique({
    where: { id: postVersionId },
    select: {
      id: true,
      postId: true,
      versionHash: true,
      serverVerifiedAt: true,
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

/**
 * Extract client-sent HTML from the ViewPostInput metadata, if any.
 *
 * Captures client-origin HTML independently from server-origin HTML so each
 * source can be persisted without overwriting the other.
 */
function extractClientHtml(viewInput: ViewPostInput): string | undefined {
  switch (viewInput.platform) {
    case "LESSWRONG":
      return viewInput.metadata.htmlContent;
    case "SUBSTACK":
      return viewInput.metadata.htmlContent ?? undefined;
    case "X":
    case "WIKIPEDIA":
      return undefined;
  }
}

interface HtmlSnapshotsForStorage {
  serverHtml?: string;
  clientHtml?: string;
}

async function resolveHtmlBlobIdsForStorage(
  prisma: DbClient,
  htmlSnapshotsForStorage: HtmlSnapshotsForStorage,
): Promise<{ serverHtmlBlobId: string | null; clientHtmlBlobId: string | null }> {
  const serverHtml = htmlSnapshotsForStorage.serverHtml;
  const clientHtml = htmlSnapshotsForStorage.clientHtml;

  // Avoid self-racing unique insert inside one transaction when both sources
  // carry identical HTML bytes.
  if (serverHtml !== undefined && clientHtml !== undefined && serverHtml === clientHtml) {
    const sharedBlob = await getOrCreateHtmlBlob(prisma, serverHtml);
    return {
      serverHtmlBlobId: sharedBlob.id,
      clientHtmlBlobId: sharedBlob.id,
    };
  }

  const [serverHtmlBlob, clientHtmlBlob] = await Promise.all([
    serverHtml !== undefined ? getOrCreateHtmlBlob(prisma, serverHtml) : null,
    clientHtml !== undefined ? getOrCreateHtmlBlob(prisma, clientHtml) : null,
  ]);
  return {
    serverHtmlBlobId: serverHtmlBlob?.id ?? null,
    clientHtmlBlobId: clientHtmlBlob?.id ?? null,
  };
}

/**
 * Resolve source-scoped HTML snapshots for version metadata storage.
 *
 * SERVER_VERIFIED observations persist canonical `serverHtml` and, when
 * available, also preserve the client DOM snapshot as `clientHtml`.
 * CLIENT_FALLBACK observations persist client HTML only.
 */
function resolveHtmlSnapshotsForStorage(
  viewInput: ViewPostInput,
  canonical: CanonicalContentVersion,
): HtmlSnapshotsForStorage {
  const clientHtml = extractClientHtml(viewInput);
  if (canonical.provenance === "SERVER_VERIFIED") {
    return {
      serverHtml: canonical.sourceHtml,
      ...(clientHtml !== undefined && { clientHtml }),
    };
  }
  return clientHtml === undefined ? {} : { clientHtml };
}

// ---------------------------------------------------------------------------
// Main entry point: registerObservedVersion
// ---------------------------------------------------------------------------

/**
 * Normalizes client-observed content, resolves the canonical version
 * (server-verified when available; client-fallback otherwise),
 * logs hash mismatches between observed and server-verified content,
 * and upserts the full Post -> PostVersion -> ContentBlob storage chain.
 */
export async function registerObservedVersion(
  prisma: PrismaClient,
  input: ViewPostInput,
): Promise<ResolvedPostVersion> {
  const initiallyPreparedInput = prepareViewPostInput(input);
  const observed = await toObservedContentVersion(initiallyPreparedInput);

  const canonical = await resolveCanonicalContentVersion({
    viewInput: initiallyPreparedInput,
    observed,
    fetchCanonicalContent,
    onServerVerifiedContentMismatch: logServerVerifiedContentMismatch,
  });

  const htmlSnapshotsForStorage = resolveHtmlSnapshotsForStorage(initiallyPreparedInput, canonical);

  const preparedInput = applyServerVerifiedWikipediaIdentity({
    preparedInput: initiallyPreparedInput,
    canonical,
  });
  for (let attempt = 0; attempt < UNIQUE_CONSTRAINT_RACE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const post = await upsertPostFromViewInput(tx, preparedInput);
        const postVersion = await upsertPostVersion(tx, {
          postId: post.id,
          canonical,
          ...(preparedInput.observedImageOccurrences === undefined
            ? {}
            : { observedImageOccurrences: preparedInput.observedImageOccurrences }),
        });
        const htmlBlobIds = await resolveHtmlBlobIdsForStorage(tx, htmlSnapshotsForStorage);
        await createPlatformVersionMetadataIfMissing(tx, {
          preparedInput,
          postVersionId: postVersion.id,
          htmlBlobIds,
        });
        return postVersion;
      });
    } catch (error) {
      if (
        !isUniqueConstraintError(error) ||
        attempt === UNIQUE_CONSTRAINT_RACE_RETRY_ATTEMPTS - 1
      ) {
        throw error;
      }
      await delay(UNIQUE_CONSTRAINT_RACE_RETRY_DELAY_MS);
    }
  }

  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Failed to register observed version due to repeated unique-constraint races",
  });
}
