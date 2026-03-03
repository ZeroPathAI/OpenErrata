import type { Platform, PlatformMetadataByPlatform } from "@openerrata/shared";
import type { PrismaClient, Prisma } from "$lib/generated/prisma/client";
import { isUniqueConstraintError } from "$lib/db/errors.js";

export type UpsertPostInput = {
  [P in Platform]: {
    platform: P;
    externalId: string;
    url: string;
    metadata: PlatformMetadataByPlatform[P];
  };
}[Platform];

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

export type DbClient = PrismaClient | Prisma.TransactionClient;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function createOrFindByUniqueConstraint<T>(input: {
  findExisting: () => Promise<T | null>;
  create: () => Promise<T>;
  assertEquivalent: (existing: T) => void;
  /**
   * Safe only outside of interactive transactions.
   * Inside a transaction, unique violations abort the transaction until rollback.
   */
  retryReadAfterUniqueConflict?: boolean;
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
    if (input.retryReadAfterUniqueConflict !== true) {
      throw error;
    }
    // For non-transactional callers, the winning insert can briefly be
    // invisible right after a unique-constraint conflict.
    for (let attempt = 0; attempt < UNIQUE_CONSTRAINT_RACE_RETRY_ATTEMPTS; attempt += 1) {
      const raced = await input.findExisting();
      if (raced !== null) {
        input.assertEquivalent(raced);
        return raced;
      }
      await delay(UNIQUE_CONSTRAINT_RACE_RETRY_DELAY_MS);
    }
    throw error;
  }
}
