import type { ViewPostInput } from "@openerrata/shared";
import { trimToOptionalNonEmpty } from "@openerrata/shared";
import { TRPCError } from "@trpc/server";
import { toOptionalDate } from "$lib/date.js";
import type { Prisma } from "$lib/generated/prisma/client";
import type { CanonicalContentVersion } from "$lib/services/canonical-resolution.js";
import { createOrFindByUniqueConstraint, type DbClient } from "./shared.js";
import { getOrCreateHtmlBlob } from "./blobs.js";
import type { PreparedViewPostInput } from "../wikipedia.js";

export async function createPlatformVersionMetadataIfMissing(
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
              clientHtmlBlobId: true,
            },
          }),
        assertEquivalent: () => {
          // No assertions — all version meta fields except postVersionId,
          // createdAt, and clientHtmlBlobId are mutable post-level metadata
          // (slug, title, karma, author info, tags can all change independently
          // of the content hash that identifies this PostVersion).
        },
      });

      // Latest-wins update for mutable metadata. Server HTML is "best available":
      // we only overwrite when a new non-null server snapshot is available.
      const mutableMetadata = {
        slug: metadata.slug,
        title: title ?? null,
        ...(serverHtmlBlobId !== null && { serverHtmlBlobId }),
        imageUrls: input.preparedInput.observedImageUrls ?? [],
        authorName: authorName ?? null,
        authorSlug: authorSlug ?? null,
        tags: metadata.tags,
        publishedAt: toOptionalDate(metadata.publishedAt),
      } satisfies Prisma.LesswrongVersionMetaUpdateInput;

      await Promise.all([
        prisma.lesswrongVersionMeta.update({
          where: { postVersionId: input.postVersionId },
          data: mutableMetadata,
        }),
        // Client HTML: first-write-wins. Client HTML is extracted from the live
        // DOM and can vary across visits (dynamic elements, JS-rendered content),
        // so we only store it once and never overwrite with a later snapshot.
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
        },
      });
      const mutableMetadata = {
        publicationSubdomain: metadata.publicationSubdomain,
        slug: metadata.slug,
        title: metadata.title,
        subtitle: metadata.subtitle ?? null,
        ...(serverHtmlBlobId !== null && { serverHtmlBlobId }),
        imageUrls: input.preparedInput.observedImageUrls ?? [],
        authorName: metadata.authorName,
        authorSubstackHandle: authorSubstackHandle ?? null,
        publishedAt: toOptionalDate(metadata.publishedAt),
        likeCount: metadata.likeCount ?? null,
        commentCount: metadata.commentCount ?? null,
      } satisfies Prisma.SubstackVersionMetaUpdateInput;

      await Promise.all([
        prisma.substackVersionMeta.update({
          where: { postVersionId: input.postVersionId },
          data: mutableMetadata,
        }),
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
              pageId: true,
              language: true,
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
              pageId: true,
              language: true,
              clientHtmlBlobId: true,
            },
          }),
        assertEquivalent: (existing) => {
          if (existing.pageId !== metadata.pageId || existing.language !== metadata.language) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `Wikipedia version identity mismatch for postVersion ${input.postVersionId}: existing=${existing.language}:${existing.pageId}, incoming=${metadata.language}:${metadata.pageId}`,
            });
          }
        },
      });
      const mutableMetadata = {
        title: metadata.title,
        displayTitle: metadata.displayTitle ?? null,
        ...(serverHtmlBlobId !== null && { serverHtmlBlobId }),
        revisionId: metadata.revisionId,
        lastModifiedAt: toOptionalDate(metadata.lastModifiedAt),
        imageUrls: input.preparedInput.observedImageUrls ?? [],
      } satisfies Prisma.WikipediaVersionMetaUpdateInput;

      await Promise.all([
        prisma.wikipediaVersionMeta.update({
          where: { postVersionId: input.postVersionId },
          data: mutableMetadata,
        }),
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

/**
 * Extract client-sent HTML from the ViewPostInput metadata, if any.
 *
 * Captures client-origin HTML independently from server-origin HTML so each
 * source can be persisted without overwriting the other.
 */
function extractClientHtml(viewInput: ViewPostInput): string | undefined {
  switch (viewInput.platform) {
    case "LESSWRONG":
    case "SUBSTACK":
    case "WIKIPEDIA":
      return viewInput.metadata.htmlContent;
    case "X":
      return undefined;
  }
}

interface HtmlSnapshotsForStorage {
  serverHtml?: string;
  clientHtml?: string;
}

export function resolveHtmlSnapshotsForStorage(
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

export async function resolveHtmlBlobIdsForStorage(
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
