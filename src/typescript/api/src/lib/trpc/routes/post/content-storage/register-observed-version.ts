import type { PrismaClient } from "$lib/db/prisma-client";
import type { ViewPostInput } from "@openerrata/shared";
import { fetchCanonicalContent } from "$lib/services/content-fetcher.js";
import { resolveCanonicalContentVersion } from "$lib/services/canonical-resolution.js";
import { TRPCError } from "@trpc/server";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import { prepareViewPostInput } from "../wikipedia.js";
import {
  UNIQUE_CONSTRAINT_RACE_RETRY_ATTEMPTS,
  UNIQUE_CONSTRAINT_RACE_RETRY_DELAY_MS,
  delay,
  type ResolvedPostVersion,
} from "./shared.js";
import { upsertPostFromViewInput } from "./post-upsert.js";
import { upsertPostVersion } from "./post-version.js";
import {
  createPlatformVersionMetadataIfMissing,
  resolveHtmlBlobIdsForStorage,
  resolveHtmlSnapshotsForStorage,
} from "./metadata.js";
import {
  applyServerVerifiedWikipediaIdentity,
  logServerVerifiedContentMismatch,
  toObservedContentVersion,
} from "./content-preparation.js";

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
    onClientFallback: (reason) => {
      console.warn(
        `Client fallback for ${initiallyPreparedInput.platform}; url=${initiallyPreparedInput.url}; reason=${reason}`,
      );
    },
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
