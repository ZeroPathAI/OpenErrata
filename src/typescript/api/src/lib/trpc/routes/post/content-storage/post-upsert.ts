import { trimToOptionalNonEmpty } from "@openerrata/shared";
import type { DbClient, UpsertPostInput } from "./shared.js";
import type { Post } from "$lib/generated/prisma/client";
import type { PreparedViewPostInput } from "../wikipedia.js";

async function upsertAuthorAndAttachToPost(
  prisma: DbClient,
  input: {
    postId: string;
    platform: UpsertPostInput["platform"];
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

export async function upsertPostFromViewInput(
  prisma: DbClient,
  input: PreparedViewPostInput,
): Promise<Post> {
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
