import type { ViewPostInput } from "@openerrata/shared";
import type { CanonicalContentVersion } from "$lib/services/canonical-resolution.js";
import { getOrCreateContentBlob } from "./blobs.js";
import {
  validateAndNormalizeImageOccurrences,
  getOrCreateImageOccurrenceSet,
} from "./occurrences.js";
import { versionHashFromContentAndImages } from "./hashing.js";
import type { DbClient, ResolvedPostVersion } from "./shared.js";

export async function upsertPostVersion(
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
