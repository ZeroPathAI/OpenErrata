import { router, publicProcedure } from "../init.js";
import {
  registerObservedVersionInputSchema,
  registerObservedVersionOutputSchema,
  recordViewAndGetStatusInputSchema,
  viewPostOutputSchema,
  getInvestigationInputSchema,
  getInvestigationOutputSchema,
  investigateNowInputSchema,
  investigateNowOutputSchema,
  batchStatusInputSchema,
  batchStatusOutputSchema,
  claimIdSchema,
  settingsValidationOutputSchema,
  normalizeContent,
  hashContent,
  validateAndSortImageOccurrences,
  type Platform,
  type InvestigationClaim,
  type ExtensionRuntimeErrorCode,
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
import { getOrCreateCurrentPrompt } from "$lib/services/prompt.js";
import {
  ensureInvestigationQueued,
  InvestigationWordLimitError,
  wordCount,
} from "$lib/services/investigation-lifecycle.js";
import { maybeIncrementUniqueViewScore } from "$lib/services/view-credit.js";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import { attachOpenAiKeySourceIfPendingRun } from "$lib/services/user-key-source.js";
import { validateOpenAiApiKeyForSettings } from "$lib/services/openai-key-validation.js";
import { toOptionalDate } from "$lib/date.js";
import type { PrismaClient } from "$lib/generated/prisma/client";
import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";

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

type ResolvedPostVersion = {
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
};

const CONTENT_MISMATCH_ERROR_CODE: ExtensionRuntimeErrorCode = "CONTENT_MISMATCH";

function unreachableInvestigationStatus(status: never): never {
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: `Unexpected investigation status: ${String(status)}`,
  });
}

function requireCompleteCheckedAtIso(investigationId: string, checkedAt: Date | null): string {
  if (checkedAt === null) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Investigation ${investigationId} is COMPLETE with null checkedAt`,
    });
  }
  return checkedAt.toISOString();
}

function contentMismatchError(): TRPCError {
  return new TRPCError({
    code: "BAD_REQUEST",
    message: "Observed content does not match canonical content",
    cause: { openerrataCode: CONTENT_MISMATCH_ERROR_CODE },
  });
}

function trimToOptionalNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

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

async function toObservedContentVersion(input: ViewPostInput): Promise<ObservedContentVersion> {
  const contentText =
    input.platform === "LESSWRONG"
      ? lesswrongHtmlToNormalizedText(input.metadata.htmlContent)
      : normalizeContent(input.observedContentText);
  const contentHash = await hashContent(contentText);
  return { contentText, contentHash };
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

async function upsertPostFromViewInput(prisma: PrismaClient, input: ViewPostInput) {
  const commonInput = {
    externalId: input.externalId,
    url: input.url,
    ...(input.observedImageUrls !== undefined && { observedImageUrls: input.observedImageUrls }),
  };

  if (input.platform === "LESSWRONG") {
    return upsertPost(prisma, {
      ...commonInput,
      platform: "LESSWRONG",
      metadata: input.metadata,
    });
  }

  if (input.platform === "X") {
    return upsertPost(prisma, {
      ...commonInput,
      platform: "X",
      metadata: input.metadata,
    });
  }

  if (input.platform === "WIKIPEDIA") {
    return upsertPost(prisma, {
      ...commonInput,
      platform: "WIKIPEDIA",
      metadata: input.metadata,
    });
  }

  return upsertPost(prisma, {
    ...commonInput,
    platform: "SUBSTACK",
    metadata: input.metadata,
  });
}

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
  stored: Array<{
    originalIndex: number;
    normalizedTextOffset: number;
    sourceUrl: string;
    captionText: string | null;
  }>,
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

async function getOrCreateContentBlob(
  prisma: PrismaClient,
  input: {
    contentHash: string;
    contentText: string;
  },
) {
  const existing = await prisma.contentBlob.findUnique({
    where: { contentHash: input.contentHash },
  });
  if (existing !== null) {
    if (existing.contentText !== input.contentText) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `contentHash collision for ${input.contentHash}`,
      });
    }
    return existing;
  }

  try {
    return await prisma.contentBlob.create({
      data: {
        contentHash: input.contentHash,
        contentText: input.contentText,
        wordCount: wordCount(input.contentText),
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const raced = await prisma.contentBlob.findUnique({
      where: { contentHash: input.contentHash },
    });
    if (raced === null) {
      throw error;
    }
    if (raced.contentText !== input.contentText) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `contentHash collision for ${input.contentHash}`,
      });
    }
    return raced;
  }
}

async function getOrCreateImageOccurrenceSet(
  prisma: PrismaClient,
  normalizedOccurrences: NonNullable<ViewPostInput["observedImageOccurrences"]>,
) {
  const occurrencesHash = imageOccurrencesHash(normalizedOccurrences);

  const existing = await prisma.imageOccurrenceSet.findUnique({
    where: { occurrencesHash },
    include: {
      occurrences: {
        orderBy: [{ originalIndex: "asc" }],
      },
    },
  });
  if (existing !== null) {
    if (!hasSameNormalizedOccurrences(existing.occurrences, normalizedOccurrences)) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `image occurrence hash collision for ${occurrencesHash}`,
      });
    }
    return existing;
  }

  try {
    return await prisma.imageOccurrenceSet.create({
      data: {
        occurrencesHash,
        ...(normalizedOccurrences.length === 0
          ? {}
          : {
              occurrences: {
                create: normalizedOccurrenceToData(normalizedOccurrences),
              },
            }),
      },
      include: {
        occurrences: {
          orderBy: [{ originalIndex: "asc" }],
        },
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const raced = await prisma.imageOccurrenceSet.findUnique({
      where: { occurrencesHash },
      include: {
        occurrences: {
          orderBy: [{ originalIndex: "asc" }],
        },
      },
    });
    if (raced === null) {
      throw error;
    }
    if (!hasSameNormalizedOccurrences(raced.occurrences, normalizedOccurrences)) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `image occurrence hash collision for ${occurrencesHash}`,
      });
    }
    return raced;
  }
}

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

async function findPostVersionById(
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

async function loadInvestigationWithClaims(prisma: PrismaClient, investigationId: string) {
  return prisma.investigation.findUnique({
    where: { id: investigationId },
    include: {
      postVersion: {
        select: {
          contentProvenance: true,
          contentBlob: {
            select: {
              contentText: true,
              contentHash: true,
            },
          },
        },
      },
      claims: {
        include: {
          sources: true,
        },
      },
      parentInvestigation: {
        include: {
          claims: {
            include: {
              sources: true,
            },
          },
          postVersion: {
            select: {
              contentBlob: {
                select: {
                  contentText: true,
                },
              },
            },
          },
        },
      },
    },
  });
}

async function findCompletedInvestigationByPostVersionId(
  prisma: PrismaClient,
  postVersionId: string,
) {
  return prisma.investigation.findFirst({
    where: {
      postVersionId,
      status: "COMPLETE",
    },
    include: {
      postVersion: {
        select: {
          id: true,
          contentProvenance: true,
          contentBlob: {
            select: {
              contentText: true,
              contentHash: true,
            },
          },
        },
      },
      claims: {
        include: {
          sources: true,
        },
      },
    },
  });
}

async function findLatestServerVerifiedCompleteInvestigationForPost(
  prisma: PrismaClient,
  postId: string,
) {
  return prisma.investigation.findFirst({
    where: {
      status: "COMPLETE",
      postVersion: {
        postId,
        contentProvenance: "SERVER_VERIFIED",
      },
    },
    orderBy: {
      checkedAt: "desc",
    },
    include: {
      postVersion: {
        select: {
          id: true,
          contentBlob: {
            select: {
              contentText: true,
            },
          },
        },
      },
      claims: {
        include: {
          sources: true,
        },
      },
    },
  });
}

type LatestServerVerifiedCompleteInvestigation = Awaited<
  ReturnType<typeof findLatestServerVerifiedCompleteInvestigationForPost>
>;

function selectSourceInvestigationForUpdate(
  latestServerVerifiedSource: LatestServerVerifiedCompleteInvestigation,
  currentPostVersionId: string,
): LatestServerVerifiedCompleteInvestigation {
  if (latestServerVerifiedSource === null) {
    return null;
  }

  return latestServerVerifiedSource.postVersion.id === currentPostVersionId
    ? null
    : latestServerVerifiedSource;
}

function toPriorInvestigationResult(
  sourceInvestigation: LatestServerVerifiedCompleteInvestigation,
): {
  oldClaims: InvestigationClaim[];
  sourceInvestigationId: string;
} | null {
  if (sourceInvestigation === null) {
    return null;
  }

  return {
    oldClaims: formatClaims(sourceInvestigation.claims),
    sourceInvestigationId: sourceInvestigation.id,
  };
}

function formatClaims(
  claims: Array<{
    id: string;
    text: string;
    context: string;
    summary: string;
    reasoning: string;
    sources: Array<{ url: string; title: string; snippet: string }>;
  }>,
): InvestigationClaim[] {
  return claims.map((c) => ({
    id: claimIdSchema.parse(c.id),
    text: c.text,
    context: c.context,
    summary: c.summary,
    reasoning: c.reasoning,
    sources: c.sources.map((s) => ({
      url: s.url,
      title: s.title,
      snippet: s.snippet,
    })),
  }));
}

function buildLineDiff(previous: string, current: string): string {
  if (previous === current) {
    return "No changes detected.";
  }

  const previousLines = previous.split("\n");
  const currentLines = current.split("\n");
  const maxStart = Math.min(previousLines.length, currentLines.length);
  let start = 0;
  while (start < maxStart && previousLines[start] === currentLines[start]) {
    start += 1;
  }

  let previousEnd = previousLines.length;
  let currentEnd = currentLines.length;
  while (
    previousEnd > start &&
    currentEnd > start &&
    previousLines[previousEnd - 1] === currentLines[currentEnd - 1]
  ) {
    previousEnd -= 1;
    currentEnd -= 1;
  }

  const removed = previousLines.slice(start, previousEnd);
  const added = currentLines.slice(start, currentEnd);

  return [
    "Diff summary (line context):",
    "- Removed lines:",
    removed.length > 0 ? removed.join("\n") : "(none)",
    "+ Added lines:",
    added.length > 0 ? added.join("\n") : "(none)",
  ].join("\n");
}

async function maybeRecordCorroboration(
  prisma: PrismaClient,
  postVersionId: string,
  viewerKey: string,
  isAuthenticated: boolean,
): Promise<void> {
  if (!isAuthenticated) return;

  const investigation = await prisma.investigation.findFirst({
    where: {
      postVersionId,
      postVersion: {
        contentProvenance: "CLIENT_FALLBACK",
      },
    },
    select: { id: true },
  });

  if (!investigation) return;

  try {
    await prisma.corroborationCredit.create({
      data: {
        investigationId: investigation.id,
        reporterKey: viewerKey,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return;
    throw error;
  }
}

async function ensureInvestigationsWithUpdateMetadata(input: {
  prisma: PrismaClient;
  promptId: string;
  postVersion: ResolvedPostVersion;
  sourceInvestigation: LatestServerVerifiedCompleteInvestigation;
  onPendingRun?: Parameters<typeof ensureInvestigationQueued>[0]["onPendingRun"];
}) {
  if (input.sourceInvestigation === null) {
    return ensureInvestigationQueued({
      prisma: input.prisma,
      postVersionId: input.postVersion.id,
      promptId: input.promptId,
      rejectOverWordLimitOnCreate: true,
      allowRequeueFailed: true,
      ...(input.onPendingRun === undefined ? {} : { onPendingRun: input.onPendingRun }),
    });
  }

  const contentDiff = buildLineDiff(
    input.sourceInvestigation.postVersion.contentBlob.contentText,
    input.postVersion.contentBlob.contentText,
  );
  return ensureInvestigationQueued({
    prisma: input.prisma,
    postVersionId: input.postVersion.id,
    promptId: input.promptId,
    parentInvestigationId: input.sourceInvestigation.id,
    contentDiff,
    rejectOverWordLimitOnCreate: true,
    allowRequeueFailed: true,
    ...(input.onPendingRun === undefined ? {} : { onPendingRun: input.onPendingRun }),
  });
}

async function registerObservedVersion(
  prisma: PrismaClient,
  input: ViewPostInput,
): Promise<ResolvedPostVersion> {
  const observed = await toObservedContentVersion(input);

  const canonicalResolution = await resolveCanonicalContentVersion({
    viewInput: input,
    observed,
    fetchCanonicalContent,
  });
  if (canonicalResolution.state === "CONTENT_MISMATCH") {
    throw contentMismatchError();
  }

  const post = await upsertPostFromViewInput(prisma, input);

  return upsertPostVersion(prisma, {
    postId: post.id,
    canonical: canonicalResolution.canonical,
    ...(input.observedImageOccurrences === undefined
      ? {}
      : { observedImageOccurrences: input.observedImageOccurrences }),
  });
}

export const postRouter = router({
  registerObservedVersion: publicProcedure
    .input(registerObservedVersionInputSchema)
    .output(registerObservedVersionOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const postVersion = await registerObservedVersion(ctx.prisma, input);

      return {
        platform: postVersion.post.platform,
        externalId: postVersion.post.externalId,
        versionHash: postVersion.versionHash,
        postVersionId: postVersion.id,
        provenance: postVersion.contentProvenance,
      };
    }),

  recordViewAndGetStatus: publicProcedure
    .input(recordViewAndGetStatusInputSchema)
    .output(viewPostOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const postVersion = await findPostVersionById(ctx.prisma, input.postVersionId);
      if (postVersion === null) {
        return {
          investigationState: "NOT_INVESTIGATED" as const,
          claims: null,
          priorInvestigationResult: null,
        };
      }

      await ctx.prisma.post.update({
        where: { id: postVersion.post.id },
        data: {
          viewCount: { increment: 1 },
          lastViewedAt: new Date(),
        },
      });

      await maybeIncrementUniqueViewScore(
        ctx.prisma,
        postVersion.post.id,
        ctx.viewerKey,
        ctx.ipRangeKey,
      );

      await maybeRecordCorroboration(
        ctx.prisma,
        postVersion.id,
        ctx.viewerKey,
        ctx.isAuthenticated,
      );

      const complete = await findCompletedInvestigationByPostVersionId(ctx.prisma, postVersion.id);

      if (complete) {
        return {
          investigationState: "INVESTIGATED" as const,
          provenance: complete.postVersion.contentProvenance,
          claims: formatClaims(complete.claims),
        };
      }

      const latestServerVerifiedSource = await findLatestServerVerifiedCompleteInvestigationForPost(
        ctx.prisma,
        postVersion.post.id,
      );

      const sourceInvestigation = selectSourceInvestigationForUpdate(
        latestServerVerifiedSource,
        postVersion.id,
      );

      return {
        investigationState: "NOT_INVESTIGATED" as const,
        claims: null,
        priorInvestigationResult: toPriorInvestigationResult(sourceInvestigation),
      };
    }),

  getInvestigation: publicProcedure
    .input(getInvestigationInputSchema)
    .output(getInvestigationOutputSchema)
    .query(async ({ input, ctx }) => {
      const investigation = await loadInvestigationWithClaims(ctx.prisma, input.investigationId);

      if (!investigation) {
        return {
          investigationState: "NOT_INVESTIGATED" as const,
          claims: null,
          priorInvestigationResult: null,
        };
      }

      const provenance = investigation.postVersion.contentProvenance;

      switch (investigation.status) {
        case "COMPLETE":
          return {
            investigationState: "INVESTIGATED" as const,
            provenance,
            claims: formatClaims(investigation.claims),
            checkedAt: requireCompleteCheckedAtIso(investigation.id, investigation.checkedAt),
          };
        case "PENDING":
        case "PROCESSING":
          return {
            investigationState: "INVESTIGATING" as const,
            status: investigation.status,
            provenance,
            claims: null,
            priorInvestigationResult:
              investigation.parentInvestigation !== null &&
              investigation.parentInvestigation.status === "COMPLETE"
                ? {
                    oldClaims: formatClaims(investigation.parentInvestigation.claims),
                    sourceInvestigationId: investigation.parentInvestigation.id,
                  }
                : null,
            checkedAt: investigation.checkedAt?.toISOString(),
          };
        case "FAILED":
          return {
            investigationState: "FAILED" as const,
            provenance,
            claims: null,
            checkedAt: investigation.checkedAt?.toISOString(),
          };
        default:
          return unreachableInvestigationStatus(investigation.status);
      }
    }),

  investigateNow: publicProcedure
    .input(investigateNowInputSchema)
    .output(investigateNowOutputSchema)
    .mutation(async ({ input, ctx }) => {
      if (!ctx.canInvestigate) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Valid API key or x-openai-api-key required for investigateNow",
        });
      }

      const postVersion = await findPostVersionById(ctx.prisma, input.postVersionId);
      if (postVersion === null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Unknown post version",
        });
      }

      const complete = await findCompletedInvestigationByPostVersionId(ctx.prisma, postVersion.id);
      if (complete) {
        return {
          investigationId: complete.id,
          status: complete.status,
          provenance: complete.postVersion.contentProvenance,
          claims: formatClaims(complete.claims),
        };
      }

      const latestServerVerifiedSource = await findLatestServerVerifiedCompleteInvestigationForPost(
        ctx.prisma,
        postVersion.post.id,
      );

      const sourceInvestigation = selectSourceInvestigationForUpdate(
        latestServerVerifiedSource,
        postVersion.id,
      );

      const prompt = await getOrCreateCurrentPrompt();
      try {
        const { investigation } = await ensureInvestigationsWithUpdateMetadata({
          prisma: ctx.prisma,
          postVersion,
          promptId: prompt.id,
          sourceInvestigation,
          onPendingRun: async ({ prisma, run }) => {
            if (ctx.userOpenAiApiKey === null) return;
            await attachOpenAiKeySourceIfPendingRun(prisma, {
              runId: run.id,
              openAiApiKey: ctx.userOpenAiApiKey,
            });
          },
        });

        switch (investigation.status) {
          case "COMPLETE": {
            const completed = await loadInvestigationWithClaims(ctx.prisma, investigation.id);
            if (!completed) {
              throw new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message: `Investigation ${investigation.id} disappeared after completion lookup`,
              });
            }

            return {
              investigationId: completed.id,
              status: completed.status,
              provenance: completed.postVersion.contentProvenance,
              claims: formatClaims(completed.claims),
            };
          }
          case "PENDING":
          case "PROCESSING":
          case "FAILED":
            return {
              investigationId: investigation.id,
              status: investigation.status,
              provenance: postVersion.contentProvenance,
            };
          default:
            return unreachableInvestigationStatus(investigation.status);
        }
      } catch (error) {
        if (error instanceof InvestigationWordLimitError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error.message,
          });
        }
        throw error;
      }
    }),

  validateSettings: publicProcedure
    .output(settingsValidationOutputSchema)
    .query(async ({ ctx }) => {
      const openaiValidation = await validateOpenAiApiKeyForSettings(ctx.userOpenAiApiKey);

      return settingsValidationOutputSchema.parse({
        instanceApiKeyAccepted: ctx.isAuthenticated,
        ...openaiValidation,
      });
    }),

  batchStatus: publicProcedure
    .input(batchStatusInputSchema)
    .output(batchStatusOutputSchema)
    .query(async ({ input, ctx }) => {
      const lookupKey = (platform: Platform, externalId: string, versionHash: string): string =>
        `${platform}:${externalId}:${versionHash}`;

      const versions =
        input.posts.length === 0
          ? []
          : await ctx.prisma.postVersion.findMany({
              where: {
                OR: input.posts.map((post) => ({
                  versionHash: post.versionHash,
                  post: {
                    platform: post.platform,
                    externalId: post.externalId,
                  },
                })),
              },
              select: {
                versionHash: true,
                post: {
                  select: {
                    platform: true,
                    externalId: true,
                  },
                },
                investigation: {
                  select: {
                    status: true,
                    _count: {
                      select: {
                        claims: true,
                      },
                    },
                  },
                },
              },
            });

      const byLookupKey = new Map<string, (typeof versions)[number]>();
      for (const version of versions) {
        byLookupKey.set(
          lookupKey(version.post.platform, version.post.externalId, version.versionHash),
          version,
        );
      }

      const statuses = input.posts.map((post) => {
        const matched = byLookupKey.get(
          lookupKey(post.platform, post.externalId, post.versionHash),
        );

        if (matched?.investigation?.status !== "COMPLETE") {
          return {
            platform: post.platform,
            externalId: post.externalId,
            investigationState: "NOT_INVESTIGATED" as const,
            incorrectClaimCount: 0 as const,
          };
        }

        return {
          platform: post.platform,
          externalId: post.externalId,
          investigationState: "INVESTIGATED" as const,
          incorrectClaimCount: matched.investigation._count.claims,
        };
      });

      return { statuses };
    }),
});
