import { router, publicProcedure } from "../init.js";
import {
  viewPostInputSchema,
  getInvestigationInputSchema,
  investigateNowInputSchema,
  batchStatusInputSchema,
  normalizeContent,
  hashContent,
  type Platform,
  type InvestigationClaim,
  type ContentProvenance,
  type PlatformMetadataByPlatform,
  type ViewPostInput,
} from "@truesight/shared";
import { fetchCanonicalContent } from "$lib/services/content-fetcher.js";
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
    observedImageUrls?: string[];
    metadata: PlatformMetadataByPlatform[P];
  };
}[Platform];

type ContentVersion = {
  contentText: string;
  contentHash: string;
};

type CanonicalContentVersion = ContentVersion & {
  provenance: ContentProvenance;
  fetchFailureReason?: string;
};

function unreachableInvestigationStatus(status: never): never {
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: `Unexpected investigation status: ${String(status)}`,
  });
}

function contentMismatchError(): TRPCError {
  return new TRPCError({
    code: "BAD_REQUEST",
    message: "CONTENT_MISMATCH",
  });
}

async function toObservedContentVersion(observedContentText: string): Promise<ContentVersion> {
  const contentText = normalizeContent(observedContentText);
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

  if (serverResult.success) {
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
    fetchFailureReason: serverResult.failureReason,
  };
}

async function linkAuthorAndMetadata(
  prisma: PrismaClient,
  input: PostMetadataInput,
): Promise<void> {
  if (input.platform === "LESSWRONG") {
    const authorName = input.metadata.authorName?.trim();
    const authorSlug = input.metadata.authorSlug?.trim() || undefined;
    const authorDisplayName = authorName ?? authorSlug;

    if (authorDisplayName) {
      const platformUserId =
        authorSlug ?? `name:${authorDisplayName.toLowerCase()}`;
      const author = await prisma.author.upsert({
        where: {
          platform_platformUserId: {
            platform: "LESSWRONG",
            platformUserId,
          },
        },
        create: {
          platform: "LESSWRONG",
          platformUserId,
          displayName: authorDisplayName,
        },
        update: {
          displayName: authorDisplayName,
        },
        select: { id: true },
      });

      await prisma.post.update({
        where: { id: input.postId },
        data: { authorId: author.id },
      });
    }

    const title = input.metadata.title?.trim();
    const htmlContent = input.metadata.htmlContent;
    const metadataAuthorName = authorName ?? authorSlug;

    if (title && metadataAuthorName) {
      await prisma.lesswrongMeta.upsert({
        where: { postId: input.postId },
        create: {
          postId: input.postId,
          slug: input.metadata.slug,
          title,
          htmlContent,
          imageUrls: input.observedImageUrls ?? [],
          authorName: metadataAuthorName,
          authorSlug: authorSlug ?? null,
          tags: input.metadata.tags,
          publishedAt: input.metadata.publishedAt
            ? new Date(input.metadata.publishedAt)
            : null,
        },
        update: {
          slug: input.metadata.slug,
          title,
          htmlContent,
          imageUrls: input.observedImageUrls ?? [],
          authorName: metadataAuthorName,
          authorSlug: authorSlug ?? null,
          tags: input.metadata.tags,
          publishedAt: input.metadata.publishedAt
            ? new Date(input.metadata.publishedAt)
            : null,
        },
      });
    }

    return;
  }

  if (input.platform === "X") {
    const authorHandle = input.metadata.authorHandle;
    const authorDisplayName = input.metadata.authorDisplayName?.trim() || undefined;

    const author = await prisma.author.upsert({
      where: {
        platform_platformUserId: {
          platform: "X",
          platformUserId: authorHandle,
        },
      },
      create: {
        platform: "X",
        platformUserId: authorHandle,
        displayName: authorDisplayName ?? authorHandle,
      },
      update: {
        displayName: authorDisplayName ?? authorHandle,
      },
      select: { id: true },
    });

    await prisma.post.update({
      where: { id: input.postId },
      data: { authorId: author.id },
    });

    await prisma.xMeta.upsert({
      where: { postId: input.postId },
      create: {
        postId: input.postId,
        tweetId: input.externalId,
        text: input.metadata.text,
        authorHandle,
        authorDisplayName: authorDisplayName ?? null,
        mediaUrls: input.metadata.mediaUrls,
        likeCount: input.metadata.likeCount,
        retweetCount: input.metadata.retweetCount,
        postedAt: input.metadata.postedAt ? new Date(input.metadata.postedAt) : null,
      },
      update: {
        text: input.metadata.text,
        authorHandle,
        authorDisplayName: authorDisplayName ?? null,
        mediaUrls: input.metadata.mediaUrls,
        likeCount: input.metadata.likeCount,
        retweetCount: input.metadata.retweetCount,
        postedAt: input.metadata.postedAt ? new Date(input.metadata.postedAt) : null,
      },
    });
    return;
  }

  const authorName = input.metadata.authorName.trim();
  const authorSubstackHandle =
    input.metadata.authorSubstackHandle?.trim() || undefined;
  const platformUserId =
    authorSubstackHandle ??
    `publication:${input.metadata.publicationSubdomain}:name:${authorName.toLowerCase()}`;

  const author = await prisma.author.upsert({
    where: {
      platform_platformUserId: {
        platform: "SUBSTACK",
        platformUserId,
      },
    },
    create: {
      platform: "SUBSTACK",
      platformUserId,
      displayName: authorName,
    },
    update: {
      displayName: authorName,
    },
    select: { id: true },
  });

  await prisma.post.update({
    where: { id: input.postId },
    data: { authorId: author.id },
  });

  await prisma.substackMeta.upsert({
    where: { postId: input.postId },
    create: {
      postId: input.postId,
      substackPostId: input.metadata.substackPostId,
      publicationSubdomain: input.metadata.publicationSubdomain,
      slug: input.metadata.slug,
      title: input.metadata.title,
      subtitle: input.metadata.subtitle ?? null,
      imageUrls: input.observedImageUrls ?? [],
      authorName,
      authorSubstackHandle: authorSubstackHandle ?? null,
      publishedAt: input.metadata.publishedAt
        ? new Date(input.metadata.publishedAt)
        : null,
      likeCount: input.metadata.likeCount,
      commentCount: input.metadata.commentCount,
    },
    update: {
      substackPostId: input.metadata.substackPostId,
      publicationSubdomain: input.metadata.publicationSubdomain,
      slug: input.metadata.slug,
      title: input.metadata.title,
      subtitle: input.metadata.subtitle ?? null,
      imageUrls: input.observedImageUrls ?? [],
      authorName,
      authorSubstackHandle: authorSubstackHandle ?? null,
      publishedAt: input.metadata.publishedAt
        ? new Date(input.metadata.publishedAt)
        : null,
      likeCount: input.metadata.likeCount,
      commentCount: input.metadata.commentCount,
    },
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
      wordCount: wordCount(input.contentText),
    },
  });

  if (input.platform === "LESSWRONG") {
    await linkAuthorAndMetadata(prisma, {
      postId: post.id,
      platform: "LESSWRONG",
      externalId: input.externalId,
      metadata: input.metadata,
      observedImageUrls: input.observedImageUrls,
    });
  } else if (input.platform === "X") {
    await linkAuthorAndMetadata(prisma, {
      postId: post.id,
      platform: "X",
      externalId: input.externalId,
      metadata: input.metadata,
      observedImageUrls: input.observedImageUrls,
    });
  } else {
    await linkAuthorAndMetadata(prisma, {
      postId: post.id,
      platform: "SUBSTACK",
      externalId: input.externalId,
      metadata: input.metadata,
      observedImageUrls: input.observedImageUrls,
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
  if (input.platform === "LESSWRONG") {
    return upsertPost(
      prisma,
      {
        platform: "LESSWRONG",
        externalId: input.externalId,
        url: input.url,
        contentText: canonical.contentText,
        contentHash: canonical.contentHash,
        observedImageUrls: input.observedImageUrls,
        metadata: input.metadata,
      },
      options,
    );
  }

  if (input.platform === "X") {
    return upsertPost(
      prisma,
      {
        platform: "X",
        externalId: input.externalId,
        url: input.url,
        contentText: canonical.contentText,
        contentHash: canonical.contentHash,
        observedImageUrls: input.observedImageUrls,
        metadata: input.metadata,
      },
      options,
    );
  }

  return upsertPost(
    prisma,
    {
      platform: "SUBSTACK",
      externalId: input.externalId,
      url: input.url,
      contentText: canonical.contentText,
      contentHash: canonical.contentHash,
      observedImageUrls: input.observedImageUrls,
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
    text: string;
    context: string;
    summary: string;
    reasoning: string;
    sources: Array<{ url: string; title: string; snippet: string }>;
  }>,
): InvestigationClaim[] {
  return claims.map((c) => ({
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
  };
}

type PreparedPostForInvestigation = {
  post: Awaited<ReturnType<typeof upsertPostFromViewInput>>;
  canonical: CanonicalContentVersion;
  complete: Awaited<ReturnType<typeof findCompletedInvestigationByPostAndHash>>;
};

async function preparePostForInvestigation(
  prisma: PrismaClient,
  input: ViewPostInput,
  options: { countAsView: boolean },
): Promise<PreparedPostForInvestigation> {
  const observed = await toObservedContentVersion(input.observedContentText);

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

  return {
    post,
    canonical,
    complete,
  };
}

export const postRouter = router({
  viewPost: publicProcedure
    .input(viewPostInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { post, canonical, complete } = await preparePostForInvestigation(
        ctx.prisma,
        input,
        {
        countAsView: true,
      });

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
          investigated: true,
          provenance: complete.contentProvenance,
          claims: formatClaims(complete.claims),
        };
      }

      return {
        investigated: false,
        claims: null,
      };
    }),

  getInvestigation: publicProcedure
    .input(getInvestigationInputSchema)
    .query(async ({ input, ctx }) => {
      const investigation = await loadInvestigationWithClaims(
        ctx.prisma,
        input.investigationId,
      );

      if (!investigation) {
        return { investigated: false, claims: null };
      }

      return {
        investigated: investigation.status === "COMPLETE",
        status: investigation.status,
        provenance: investigation.contentProvenance,
        claims:
          investigation.status === "COMPLETE"
            ? formatClaims(investigation.claims)
            : null,
        checkedAt: investigation.checkedAt?.toISOString(),
      };
    }),

  investigateNow: publicProcedure
    .input(investigateNowInputSchema)
    .mutation(async ({ input, ctx }) => {
      if (!ctx.canInvestigate) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Valid API key or x-openai-api-key required for investigateNow",
        });
      }

      const { post, canonical, complete } = await preparePostForInvestigation(
        ctx.prisma,
        input,
        {
        countAsView: false,
      });

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
        const canonicalInvestigationContent = {
          contentHash: canonical.contentHash,
          contentText: canonical.contentText,
          provenance: canonical.provenance,
          ...(canonical.fetchFailureReason === undefined
            ? {}
            : { fetchFailureReason: canonical.fetchFailureReason }),
        };

        const { investigation } = await ensureInvestigationQueued({
          prisma: ctx.prisma,
          postId: post.id,
          promptId: prompt.id,
          canonical: canonicalInvestigationContent,
          rejectOverWordLimitOnCreate: true,
          allowRequeueFailed: true,
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

  batchStatus: publicProcedure
    .input(batchStatusInputSchema)
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
        if (!matchedPost || matchedPost.latestContentHash === null) {
          return {
            platform: post.platform,
            externalId: post.externalId,
            investigated: false,
            incorrectClaimCount: 0,
          };
        }

        const claimCount = incorrectClaimCountByPostId.get(matchedPost.id);
        return {
          platform: post.platform,
          externalId: post.externalId,
          investigated: claimCount !== undefined,
          incorrectClaimCount: claimCount ?? 0,
        };
      });

      return { statuses };
    }),
});
