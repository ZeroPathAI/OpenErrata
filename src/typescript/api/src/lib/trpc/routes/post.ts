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
  isExtensionVersionAtLeast,
  trimToOptionalNonEmpty,
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

interface ResolvedPostVersion {
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
const UPGRADE_REQUIRED_ERROR_CODE: ExtensionRuntimeErrorCode = "UPGRADE_REQUIRED";
const MALFORMED_EXTENSION_VERSION_ERROR_CODE: ExtensionRuntimeErrorCode =
  "MALFORMED_EXTENSION_VERSION";
const WIKIPEDIA_HOST_REGEX = /^([a-z0-9-]+)(?:\.m)?\.wikipedia\.org$/i;
const WIKIPEDIA_ARTICLE_PATH_PREFIX = "/wiki/";
const WIKIPEDIA_INDEX_PATH_REGEX = /^\/w\/index\.php(?:[/?#]|$)/i;
const WIKIPEDIA_PAGE_ID_REGEX = /^\d+$/;
const UNIQUE_CONSTRAINT_RACE_RETRY_ATTEMPTS = 30;
const UNIQUE_CONSTRAINT_RACE_RETRY_DELAY_MS = 20;

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

function upgradeRequiredError(input: {
  minimumVersion: string;
  currentVersion: string | null;
}): TRPCError {
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `Extension upgrade required: minimum supported version is ${input.minimumVersion}; received ${input.currentVersion ?? "missing"}.`,
    cause: {
      openerrataCode: UPGRADE_REQUIRED_ERROR_CODE,
      minimumSupportedExtensionVersion: input.minimumVersion,
      receivedExtensionVersion: input.currentVersion,
    },
  });
}

/**
 * Validates that the client extension version meets the minimum required
 * version. Returns the validated version string on success so callers can
 * narrow the context type from `string | null` to `string`.
 */
function assertSupportedExtensionVersion(input: {
  minimumSupportedExtensionVersion: string;
  extensionVersion: string | null;
}): string {
  const minimumVersion = input.minimumSupportedExtensionVersion;
  const currentVersion = input.extensionVersion;

  if (currentVersion === null) {
    throw upgradeRequiredError({
      minimumVersion,
      currentVersion: null,
    });
  }

  const atLeastMinimum = isExtensionVersionAtLeast(currentVersion, minimumVersion);
  if (atLeastMinimum === true) {
    return currentVersion;
  }

  if (atLeastMinimum === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Malformed extension version header: "${currentVersion}"`,
      cause: { openerrataCode: MALFORMED_EXTENSION_VERSION_ERROR_CODE },
    });
  }

  throw upgradeRequiredError({
    minimumVersion,
    currentVersion,
  });
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

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

type WikipediaViewInput = Extract<ViewPostInput, { platform: "WIKIPEDIA" }>;
type PreparedWikipediaViewInput = WikipediaViewInput & {
  derivedExternalId: string;
};
type PreparedViewPostInput =
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

function prepareViewPostInput(input: ViewPostInput): PreparedViewPostInput {
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
  claims: {
    id: string;
    text: string;
    context: string;
    summary: string;
    reasoning: string;
    sources: { url: string; title: string; snippet: string }[];
  }[],
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

const extensionProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const extensionVersion = assertSupportedExtensionVersion(ctx);
  return next({ ctx: { extensionVersion } });
});

export const postRouter = router({
  registerObservedVersion: extensionProcedure
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

  recordViewAndGetStatus: extensionProcedure
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

  getInvestigation: extensionProcedure
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

  investigateNow: extensionProcedure
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

  validateSettings: extensionProcedure
    .output(settingsValidationOutputSchema)
    .query(async ({ ctx }) => {
      const openaiValidation = await validateOpenAiApiKeyForSettings(ctx.userOpenAiApiKey);

      return settingsValidationOutputSchema.parse({
        instanceApiKeyAccepted: ctx.isAuthenticated,
        ...openaiValidation,
      });
    }),

  batchStatus: extensionProcedure
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
