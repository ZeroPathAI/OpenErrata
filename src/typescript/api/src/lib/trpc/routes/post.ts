import { router, publicProcedure } from "../init.js";
import {
  viewPostInputSchema,
  viewPostOutputSchema,
  getInvestigationInputSchema,
  getInvestigationOutputSchema,
  investigateNowOutputSchema,
  batchStatusInputSchema,
  batchStatusOutputSchema,
  claimIdSchema,
  settingsValidationOutputSchema,
  normalizeContent,
  hashContent,
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
import { getOrCreateCurrentPrompt } from "$lib/services/prompt.js";
import {
  ensureInvestigationQueued,
  InvestigationWordLimitError,
  maybeUpgradeInvestigationProvenance,
  wordCount,
} from "$lib/services/investigation-lifecycle.js";
import { maybeIncrementUniqueViewScore } from "$lib/services/view-credit.js";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import { attachOpenAiKeySourceIfPendingRun } from "$lib/services/user-key-source.js";
import { validateOpenAiApiKeyForSettings } from "$lib/services/openai-key-validation.js";
import { toOptionalDate } from "$lib/date.js";
import type { PrismaClient } from "$lib/generated/prisma/client";
import { TRPCError } from "@trpc/server";

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
    contentText: string;
    contentHash: string;
    latestServerVerifiedContentHash?: string;
    observedImageUrls?: string[];
    metadata: PlatformMetadataByPlatform[P];
  };
}[Platform];

type ContentVersion = {
  contentText: string;
  contentHash: string;
};

type CanonicalContentVersion =
  | (ContentVersion & {
      provenance: "SERVER_VERIFIED";
    })
  | (ContentVersion & {
      provenance: "CLIENT_FALLBACK";
      fetchFailureReason: string;
    });

const CONTENT_MISMATCH_ERROR_CODE: ExtensionRuntimeErrorCode = "CONTENT_MISMATCH";

function unreachableInvestigationStatus(status: never): never {
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: `Unexpected investigation status: ${String(status)}`,
  });
}

function requireCompleteCheckedAtIso(
  investigationId: string,
  checkedAt: Date | null,
): string {
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
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
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

async function toObservedContentVersion(input: ViewPostInput): Promise<ContentVersion> {
  // LessWrong versioning is anchored on HTML-derived text so the observed and
  // server-verified paths use one canonicalization pipeline.
  const contentText =
    input.platform === "LESSWRONG"
      ? lesswrongHtmlToNormalizedText(input.metadata.htmlContent)
      : normalizeContent(input.observedContentText);
  const contentHash = await hashContent(contentText);
  return { contentText, contentHash };
}

async function resolveCanonicalContentVersionForMiss(
  input: {
    platform: Platform;
    externalId: string;
    url: string;
  },
  observed: ContentVersion,
): Promise<CanonicalContentVersion> {
  const serverResult = await fetchCanonicalContent(
    input.platform,
    input.url,
    input.externalId,
  );

  if (serverResult.provenance === "SERVER_VERIFIED") {
    if (serverResult.contentHash !== observed.contentHash) {
      throw contentMismatchError();
    }

    return {
      contentText: serverResult.contentText,
      contentHash: serverResult.contentHash,
      provenance: "SERVER_VERIFIED",
    };
  }

  return {
    contentText: observed.contentText,
    contentHash: observed.contentHash,
    provenance: "CLIENT_FALLBACK",
    fetchFailureReason: serverResult.fetchFailureReason,
  };
}

async function linkAuthorAndMetadata(
  prisma: PrismaClient,
  input: PostMetadataInput,
): Promise<void> {
  if (input.platform === "LESSWRONG") {
    const authorName = trimToOptionalNonEmpty(input.metadata.authorName);
    const authorSlug = trimToOptionalNonEmpty(input.metadata.authorSlug);
    const authorDisplayName = authorName ?? authorSlug;

    if (authorDisplayName) {
      const platformUserId =
        authorSlug ?? `name:${authorDisplayName.toLowerCase()}`;
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

    if (title && metadataAuthorName) {
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

  if (input.platform === "X") {
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
}

async function upsertPost(
  prisma: PrismaClient,
  input: UpsertPostInput,
  options: { countAsView: boolean },
) {
  const now = new Date();
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
      latestContentHash: input.contentHash,
      latestContentText: input.contentText,
      ...(input.latestServerVerifiedContentHash === undefined
        ? {}
        : { latestServerVerifiedContentHash: input.latestServerVerifiedContentHash }),
      wordCount: wordCount(input.contentText),
      viewCount: options.countAsView ? 1 : 0,
      lastViewedAt: options.countAsView ? now : null,
    },
    update: {
      url: input.url,
      ...(options.countAsView
        ? {
            viewCount: { increment: 1 },
            lastViewedAt: now,
          }
        : {}),
      latestContentText: input.contentText,
      latestContentHash: input.contentHash,
      ...(input.latestServerVerifiedContentHash === undefined
        ? {}
        : { latestServerVerifiedContentHash: input.latestServerVerifiedContentHash }),
      wordCount: wordCount(input.contentText),
    },
  });

  if (input.platform === "LESSWRONG") {
    await linkAuthorAndMetadata(prisma, {
      postId: post.id,
      platform: "LESSWRONG",
      externalId: input.externalId,
      metadata: input.metadata,
      ...(input.observedImageUrls !== undefined && { observedImageUrls: input.observedImageUrls }),
    });
  } else if (input.platform === "X") {
    await linkAuthorAndMetadata(prisma, {
      postId: post.id,
      platform: "X",
      externalId: input.externalId,
      metadata: input.metadata,
      ...(input.observedImageUrls !== undefined && { observedImageUrls: input.observedImageUrls }),
    });
  } else {
    await linkAuthorAndMetadata(prisma, {
      postId: post.id,
      platform: "SUBSTACK",
      externalId: input.externalId,
      metadata: input.metadata,
      ...(input.observedImageUrls !== undefined && { observedImageUrls: input.observedImageUrls }),
    });
  }

  return post;
}

async function upsertPostFromViewInput(
  prisma: PrismaClient,
  input: ViewPostInput,
  canonical: CanonicalContentVersion,
  options: { countAsView: boolean },
) {
  const commonInput = {
    externalId: input.externalId,
    url: input.url,
    contentText: canonical.contentText,
    contentHash: canonical.contentHash,
    ...(canonical.provenance === "SERVER_VERIFIED"
      ? { latestServerVerifiedContentHash: canonical.contentHash }
      : {}),
    ...(input.observedImageUrls !== undefined && { observedImageUrls: input.observedImageUrls }),
  };

  if (input.platform === "LESSWRONG") {
    return upsertPost(
      prisma,
      {
        ...commonInput,
        platform: "LESSWRONG",
        metadata: input.metadata,
      },
      options,
    );
  }

  if (input.platform === "X") {
    return upsertPost(
      prisma,
      {
        ...commonInput,
        platform: "X",
        metadata: input.metadata,
      },
      options,
    );
  }

  return upsertPost(
    prisma,
    {
      ...commonInput,
      platform: "SUBSTACK",
      metadata: input.metadata,
    },
    options,
  );
}

/**
 * If an authenticated viewer submits a hash matching a CLIENT_FALLBACK
 * investigation, record a corroboration credit. The unique constraint
 * on (investigationId, reporterKey) silently deduplicates. (spec §2.10)
 */
async function maybeRecordCorroboration(
  prisma: PrismaClient,
  postId: string,
  contentHash: string,
  viewerKey: string,
  isAuthenticated: boolean,
): Promise<void> {
  if (!isAuthenticated) return;

  const investigation = await prisma.investigation.findFirst({
    where: {
      postId,
      contentHash,
      contentProvenance: "CLIENT_FALLBACK",
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
    if (isUniqueConstraintError(error)) return; // Already recorded
    throw error;
  }
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

async function findPostId(
  prisma: PrismaClient,
  input: { platform: Platform; externalId: string },
): Promise<string | null> {
  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: input.platform,
        externalId: input.externalId,
      },
    },
    select: { id: true },
  });

  return post?.id ?? null;
}

async function loadInvestigationWithClaims(
  prisma: PrismaClient,
  investigationId: string,
) {
  return prisma.investigation.findUnique({
    where: { id: investigationId },
    include: {
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
        },
      },
    },
  });
}

async function findCompletedInvestigationByPostAndHash(
  prisma: PrismaClient,
  postId: string,
  contentHash: string,
) {
  return prisma.investigation.findFirst({
    where: {
      postId,
      contentHash,
      status: "COMPLETE",
    },
    include: {
      claims: {
        include: {
          sources: true,
        },
      },
    },
  });
}

function toCanonicalFromObserved(observed: ContentVersion): CanonicalContentVersion {
  return {
    contentText: observed.contentText,
    contentHash: observed.contentHash,
    provenance: "CLIENT_FALLBACK",
    fetchFailureReason: "Canonical server fetch unavailable",
  };
}

function toCanonicalInvestigationInput(
  canonical: CanonicalContentVersion,
): {
  contentHash: string;
  contentText: string;
  provenance: "SERVER_VERIFIED";
  fetchFailureReason?: string;
} | {
  contentHash: string;
  contentText: string;
  provenance: "CLIENT_FALLBACK";
  fetchFailureReason: string;
} {
  if (canonical.provenance === "SERVER_VERIFIED") {
    return {
      contentHash: canonical.contentHash,
      contentText: canonical.contentText,
      provenance: "SERVER_VERIFIED",
    };
  }

  return {
    contentHash: canonical.contentHash,
    contentText: canonical.contentText,
    provenance: "CLIENT_FALLBACK",
    fetchFailureReason: canonical.fetchFailureReason,
  };
}

function buildLineDiff(previous: string, current: string): string {
  if (previous === current) {
    return "No changes detected.";
  }

  const previousLines = previous.split("\n");
  const currentLines = current.split("\n");
  const maxStart = Math.min(previousLines.length, currentLines.length);
  let start = 0;
  while (
    start < maxStart &&
    previousLines[start] === currentLines[start]
  ) {
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

async function findLatestServerVerifiedCompleteInvestigationForPost(
  prisma: PrismaClient,
  postId: string,
) {
  return prisma.investigation.findFirst({
    where: {
      postId,
      status: "COMPLETE",
      contentProvenance: "SERVER_VERIFIED",
    },
    orderBy: {
      checkedAt: "desc",
    },
    include: {
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

function selectUpdateSourceInvestigation(input: {
  complete: Awaited<ReturnType<typeof findCompletedInvestigationByPostAndHash>>;
  latestServerVerifiedSource: LatestServerVerifiedCompleteInvestigation;
  canonicalContentHash: string;
}): LatestServerVerifiedCompleteInvestigation {
  if (input.latestServerVerifiedSource === null) {
    return null;
  }

  if (
    input.complete !== null &&
    input.latestServerVerifiedSource.contentHash === input.canonicalContentHash
  ) {
    return null;
  }

  return input.latestServerVerifiedSource;
}

function toPriorInvestigationResult(
  sourceInvestigation: LatestServerVerifiedCompleteInvestigation,
):
  | {
      oldClaims: InvestigationClaim[];
      sourceInvestigationId: string;
    }
  | null {
  if (sourceInvestigation === null) {
    return null;
  }

  return {
    oldClaims: formatClaims(sourceInvestigation.claims),
    sourceInvestigationId: sourceInvestigation.id,
  };
}

type PreparedPostForInvestigation = {
  post: Awaited<ReturnType<typeof upsertPostFromViewInput>>;
  canonical: CanonicalContentVersion;
  complete: Awaited<ReturnType<typeof findCompletedInvestigationByPostAndHash>>;
  sourceInvestigation: LatestServerVerifiedCompleteInvestigation;
};

async function preparePostForInvestigation(
  prisma: PrismaClient,
  input: ViewPostInput,
  options: { countAsView: boolean },
): Promise<PreparedPostForInvestigation> {
  const observed = await toObservedContentVersion(input);

  const existingPostId = await findPostId(prisma, {
    platform: input.platform,
    externalId: input.externalId,
  });

  if (existingPostId) {
    const completeFromObserved = await findCompletedInvestigationByPostAndHash(
      prisma,
      existingPostId,
      observed.contentHash,
    );
    if (completeFromObserved) {
      const canonical = toCanonicalFromObserved(observed);
      const post = await upsertPostFromViewInput(prisma, input, canonical, options);
      return {
        post,
        canonical,
        complete: completeFromObserved,
        sourceInvestigation: null,
      };
    }
  }

  const canonical = await resolveCanonicalContentVersionForMiss(
    {
      platform: input.platform,
      externalId: input.externalId,
      url: input.url,
    },
    observed,
  );

  const post = await upsertPostFromViewInput(prisma, input, canonical, options);

  if (canonical.provenance === "SERVER_VERIFIED") {
    await maybeUpgradeInvestigationProvenance(prisma, post.id, canonical.contentHash);
  }

  const complete = await findCompletedInvestigationByPostAndHash(
    prisma,
    post.id,
    canonical.contentHash,
  );

  const latestServerVerifiedSource =
    await findLatestServerVerifiedCompleteInvestigationForPost(prisma, post.id);

  return {
    post,
    canonical,
    complete,
    sourceInvestigation: selectUpdateSourceInvestigation({
      complete,
      latestServerVerifiedSource,
      canonicalContentHash: canonical.contentHash,
    }),
  };
}

async function ensureInvestigationsWithUpdateMetadata(
  input: {
    prisma: PrismaClient;
    promptId: string;
    postId: string;
    canonical: CanonicalContentVersion;
    sourceInvestigation: LatestServerVerifiedCompleteInvestigation;
    onPendingRun?: Parameters<typeof ensureInvestigationQueued>[0]["onPendingRun"];
  },
) {
  if (input.sourceInvestigation === null) {
    const investigationContent = toCanonicalInvestigationInput(input.canonical);
    return ensureInvestigationQueued({
      prisma: input.prisma,
      postId: input.postId,
      promptId: input.promptId,
      canonical: investigationContent,
      rejectOverWordLimitOnCreate: true,
      allowRequeueFailed: true,
      ...(input.onPendingRun === undefined
        ? {}
        : { onPendingRun: input.onPendingRun }),
    });
  }

  const contentDiff = buildLineDiff(
    input.sourceInvestigation.contentText,
    input.canonical.contentText,
  );
  const investigationContent = toCanonicalInvestigationInput(input.canonical);
  return ensureInvestigationQueued({
    prisma: input.prisma,
    postId: input.postId,
    promptId: input.promptId,
    canonical: investigationContent,
    parentInvestigationId: input.sourceInvestigation.id,
    contentDiff,
    rejectOverWordLimitOnCreate: true,
    allowRequeueFailed: true,
    ...(input.onPendingRun === undefined
      ? {}
      : { onPendingRun: input.onPendingRun }),
  });
}

export const postRouter = router({
  recordViewAndGetStatus: publicProcedure
    .input(viewPostInputSchema)
    .output(viewPostOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const { post, canonical, complete, sourceInvestigation } =
        await preparePostForInvestigation(
        ctx.prisma,
        input,
        {
          countAsView: true,
        },
      );

      await maybeIncrementUniqueViewScore(
        ctx.prisma,
        post.id,
        ctx.viewerKey,
        ctx.ipRangeKey,
      );

      await maybeRecordCorroboration(
        ctx.prisma,
        post.id,
        canonical.contentHash,
        ctx.viewerKey,
        ctx.isAuthenticated,
      );

      if (complete) {
        return {
          investigationState: "INVESTIGATED" as const,
          provenance: complete.contentProvenance,
          claims: formatClaims(complete.claims),
        };
      }

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
      const investigation = await loadInvestigationWithClaims(
        ctx.prisma,
        input.investigationId,
      );

      if (!investigation) {
        return {
          investigationState: "NOT_INVESTIGATED" as const,
          claims: null,
          priorInvestigationResult: null,
        };
      }

      switch (investigation.status) {
        case "COMPLETE":
          return {
            investigationState: "INVESTIGATED" as const,
            provenance: investigation.contentProvenance,
            claims: formatClaims(investigation.claims),
            checkedAt: requireCompleteCheckedAtIso(
              investigation.id,
              investigation.checkedAt,
            ),
          };
        case "PENDING":
        case "PROCESSING":
          return {
            investigationState: "INVESTIGATING" as const,
            status: investigation.status,
            provenance: investigation.contentProvenance,
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
            provenance: investigation.contentProvenance,
            claims: null,
            checkedAt: investigation.checkedAt?.toISOString(),
          };
        default:
          return unreachableInvestigationStatus(investigation.status);
      }
    }),

  investigateNow: publicProcedure
    .input(viewPostInputSchema)
    .output(investigateNowOutputSchema)
    .mutation(async ({ input, ctx }) => {
      if (!ctx.canInvestigate) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Valid API key or x-openai-api-key required for investigateNow",
        });
      }

      const { post, canonical, complete, sourceInvestigation } =
        await preparePostForInvestigation(
        ctx.prisma,
        input,
        {
          countAsView: false,
        },
      );

      if (complete) {
        return {
          investigationId: complete.id,
          status: complete.status,
          provenance: complete.contentProvenance,
          claims: formatClaims(complete.claims),
        };
      }

      const prompt = await getOrCreateCurrentPrompt();
      try {
        const { investigation } = await ensureInvestigationsWithUpdateMetadata({
          prisma: ctx.prisma,
          postId: post.id,
          promptId: prompt.id,
          canonical,
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
            const completed = await loadInvestigationWithClaims(
              ctx.prisma,
              investigation.id,
            );
            if (!completed) {
              throw new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message: `Investigation ${investigation.id} disappeared after completion lookup`,
              });
            }

            return {
              investigationId: completed.id,
              status: completed.status,
              provenance: completed.contentProvenance,
              claims: formatClaims(completed.claims),
            };
          }
          case "PENDING":
          case "PROCESSING":
          case "FAILED":
            return {
              investigationId: investigation.id,
              status: investigation.status,
              provenance: investigation.contentProvenance,
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
      const openaiValidation = await validateOpenAiApiKeyForSettings(
        ctx.userOpenAiApiKey,
      );

      return settingsValidationOutputSchema.parse({
        instanceApiKeyAccepted: ctx.isAuthenticated,
        ...openaiValidation,
      });
    }),

  batchStatus: publicProcedure
    .input(batchStatusInputSchema)
    .output(batchStatusOutputSchema)
    .query(async ({ input, ctx }) => {
      const postLookupKey = (platform: Platform, externalId: string): string =>
        `${platform}:${externalId}`;

      const requestedPostKeys = new Map<
        string,
        { platform: Platform; externalId: string }
      >();
      for (const post of input.posts) {
        const key = postLookupKey(post.platform, post.externalId);
        if (!requestedPostKeys.has(key)) {
          requestedPostKeys.set(key, {
            platform: post.platform,
            externalId: post.externalId,
          });
        }
      }

      const posts = await ctx.prisma.post.findMany({
        where: {
          OR: Array.from(requestedPostKeys.values()).map((post) => ({
            platform: post.platform,
            externalId: post.externalId,
          })),
        },
        select: {
          id: true,
          platform: true,
          externalId: true,
          latestContentHash: true,
        },
      });

      const postByLookupKey = new Map<string, (typeof posts)[number]>();
      for (const post of posts) {
        postByLookupKey.set(postLookupKey(post.platform, post.externalId), post);
      }

      const completePairs = posts.flatMap((post) => {
        if (post.latestContentHash === null) return [];

        return [
          {
            postId: post.id,
            contentHash: post.latestContentHash,
            status: "COMPLETE" as const,
          },
        ];
      });

      const completeInvestigations =
        completePairs.length === 0
          ? []
          : await ctx.prisma.investigation.findMany({
              where: { OR: completePairs },
              select: {
                postId: true,
                _count: { select: { claims: true } },
              },
            });

      const incorrectClaimCountByPostId = new Map<string, number>();
      for (const investigation of completeInvestigations) {
        incorrectClaimCountByPostId.set(
          investigation.postId,
          investigation._count.claims,
        );
      }

      const statuses = input.posts.map((post) => {
        const matchedPost = postByLookupKey.get(
          postLookupKey(post.platform, post.externalId),
        );
        if (!matchedPost?.latestContentHash) {
          return {
            platform: post.platform,
            externalId: post.externalId,
            investigationState: "NOT_INVESTIGATED" as const,
            incorrectClaimCount: 0 as const,
          };
        }

        const claimCount = incorrectClaimCountByPostId.get(matchedPost.id);
        if (claimCount === undefined) {
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
          incorrectClaimCount: claimCount,
        };
      });

      return { statuses };
    }),
});
