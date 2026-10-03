import type { Platform } from "@openerrata/shared";

export type { DbClient } from "$lib/db/client";

export interface ResolvedPostVersion {
  id: string;
  postId: string;
  versionHash: string;
  serverVerifiedAt: Date | null;
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

export const UNIQUE_CONSTRAINT_RACE_RETRY_ATTEMPTS = 30;
export const UNIQUE_CONSTRAINT_RACE_RETRY_DELAY_MS = 20;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Find-or-create inside an interactive transaction. A unique violation from a
 * concurrent insert aborts the transaction, so it propagates for the caller's
 * whole-transaction retry (registerObservedVersion) rather than being handled here.
 */
export async function createOrFindByUniqueConstraint<T>(input: {
  findExisting: () => Promise<T | null>;
  create: () => Promise<T>;
  assertEquivalent: (existing: T) => void;
}): Promise<T> {
  const existing = await input.findExisting();
  if (existing !== null) {
    input.assertEquivalent(existing);
    return existing;
  }
  return input.create();
}
