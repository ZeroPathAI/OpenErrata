/**
 * Post identity storage (SPEC §2.9 identity binding).
 *
 * A post's URL and author are identity-bound. When the server fetch verified
 * the post, they come from the platform's response and the post is latched as
 * identity-verified (Post.identityVerifiedAt). Otherwise the client's
 * validated URL and reported author are used — but never over a post whose
 * identity a server fetch has already verified.
 */

import { trimToOptionalNonEmpty, type Platform } from "@openerrata/shared";
import type { DbClient } from "$lib/db/client";
import type { CanonicalContentVersion } from "$lib/services/canonical-resolution.js";
import type { PreparedViewPostInput } from "../wikipedia.js";

interface AuthorIdentity {
  platformUserId: string;
  displayName: string;
}

interface PostIdentity {
  source: "SERVER_VERIFIED" | "CLIENT_OBSERVED";
  url: string;
  /** Null when the source names no author; the stored author link is then left as is. */
  author: AuthorIdentity | null;
}

function clientReportedAuthor(input: PreparedViewPostInput): AuthorIdentity | null {
  switch (input.platform) {
    case "LESSWRONG": {
      const authorName = trimToOptionalNonEmpty(input.metadata.authorName);
      const authorSlug = trimToOptionalNonEmpty(input.metadata.authorSlug);
      const displayName = authorName ?? authorSlug;
      if (displayName === undefined) return null;
      return {
        platformUserId: authorSlug ?? `name:${displayName.toLowerCase()}`,
        displayName,
      };
    }
    case "X": {
      const authorHandle = input.metadata.authorHandle;
      return {
        platformUserId: authorHandle,
        displayName: trimToOptionalNonEmpty(input.metadata.authorDisplayName) ?? authorHandle,
      };
    }
    case "SUBSTACK": {
      const authorName = input.metadata.authorName.trim();
      return {
        platformUserId:
          trimToOptionalNonEmpty(input.metadata.authorSubstackHandle) ??
          `publication:${input.metadata.publicationSubdomain}:name:${authorName.toLowerCase()}`,
        displayName: authorName,
      };
    }
    case "WIKIPEDIA":
      return null;
  }
}

function resolvePostIdentity(
  input: PreparedViewPostInput,
  canonical: CanonicalContentVersion,
): PostIdentity {
  if (canonical.provenance === "SERVER_VERIFIED") {
    const identity = canonical.canonicalIdentity;
    switch (identity.platform) {
      case "LESSWRONG":
        return {
          source: "SERVER_VERIFIED",
          url: identity.url,
          author:
            identity.author === null
              ? null
              : { platformUserId: identity.author.slug, displayName: identity.author.displayName },
        };
      case "WIKIPEDIA":
        return { source: "SERVER_VERIFIED", url: identity.url, author: null };
    }
  }
  return { source: "CLIENT_OBSERVED", url: input.url, author: clientReportedAuthor(input) };
}

function externalIdOf(input: PreparedViewPostInput): string {
  return input.platform === "WIKIPEDIA" ? input.derivedExternalId : input.externalId;
}

async function linkAuthor(
  db: DbClient,
  input: {
    postId: string;
    platform: Platform;
    author: AuthorIdentity;
    /** Only link when the post's identity is not server-verified. */
    onlyIfUnverified: boolean;
  },
): Promise<void> {
  const author = await db.author.upsert({
    where: {
      platform_platformUserId: {
        platform: input.platform,
        platformUserId: input.author.platformUserId,
      },
    },
    create: {
      platform: input.platform,
      platformUserId: input.author.platformUserId,
      displayName: input.author.displayName,
    },
    update: {
      displayName: input.author.displayName,
    },
    select: { id: true },
  });

  await db.post.updateMany({
    where: {
      id: input.postId,
      ...(input.onlyIfUnverified ? { identityVerifiedAt: null } : {}),
    },
    data: { authorId: author.id },
  });
}

/** Upsert the Post row for an observed version and apply its identity. Returns the post id. */
export async function upsertPostFromViewInput(
  db: DbClient,
  input: PreparedViewPostInput,
  canonical: CanonicalContentVersion,
): Promise<{ id: string }> {
  const identity = resolvePostIdentity(input, canonical);
  const verified = identity.source === "SERVER_VERIFIED";
  const now = new Date();

  const post = await db.post.upsert({
    where: {
      platform_externalId: {
        platform: input.platform,
        externalId: externalIdOf(input),
      },
    },
    create: {
      platform: input.platform,
      externalId: externalIdOf(input),
      url: identity.url,
      identityVerifiedAt: verified ? now : null,
    },
    update: verified ? { url: identity.url, identityVerifiedAt: now } : {},
    select: { id: true, identityVerifiedAt: true },
  });

  if (!verified && post.identityVerifiedAt !== null) {
    // A server fetch verified this post earlier; unverified client data
    // never overwrites that.
    return { id: post.id };
  }

  if (!verified) {
    await db.post.updateMany({
      where: { id: post.id, identityVerifiedAt: null },
      data: { url: identity.url },
    });
  }
  if (identity.author !== null) {
    await linkAuthor(db, {
      postId: post.id,
      platform: input.platform,
      author: identity.author,
      onlyIfUnverified: !verified,
    });
  }
  return { id: post.id };
}
