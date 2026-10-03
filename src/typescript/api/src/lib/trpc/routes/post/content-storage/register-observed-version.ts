import type { PrismaClient } from "$lib/db/prisma-client";
import type { ViewPostInput } from "@openerrata/shared";
import { fetchCanonicalContent } from "$lib/services/content-fetcher.js";
import { resolveCanonicalContentVersion } from "$lib/services/canonical-resolution.js";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import { prepareViewPostInput } from "../wikipedia.js";
import {
  UNIQUE_CONSTRAINT_RACE_RETRY_ATTEMPTS,
  UNIQUE_CONSTRAINT_RACE_RETRY_DELAY_MS,
  delay,
  type ResolvedPostVersion,
} from "./shared.js";
import { assertObservedPostUrlMatchesPlatform } from "./observed-url.js";
import { upsertPostFromViewInput } from "./post-upsert.js";
import { upsertPostVersion } from "./post-version.js";
import {
  upsertPlatformVersionMetadata,
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
  assertObservedPostUrlMatchesPlatform(initiallyPreparedInput);
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
  // Concurrent registrations of the same post race on unique constraints;
  // retry the whole transaction, re-throwing once the retries are spent.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const post = await upsertPostFromViewInput(tx, preparedInput, canonical);
        const postVersion = await upsertPostVersion(tx, {
          postId: post.id,
          canonical,
          ...(preparedInput.observedImageOccurrences === undefined
            ? {}
            : { observedImageOccurrences: preparedInput.observedImageOccurrences }),
        });
        const htmlBlobIds = await resolveHtmlBlobIdsForStorage(tx, htmlSnapshotsForStorage);
        await upsertPlatformVersionMetadata(tx, {
          preparedInput,
          canonical,
          postVersionId: postVersion.id,
          htmlBlobIds,
        });
        return postVersion;
      });
    } catch (error) {
      if (!isUniqueConstraintError(error) || attempt >= UNIQUE_CONSTRAINT_RACE_RETRY_ATTEMPTS) {
        throw error;
      }
      await delay(UNIQUE_CONSTRAINT_RACE_RETRY_DELAY_MS);
    }
  }
}
