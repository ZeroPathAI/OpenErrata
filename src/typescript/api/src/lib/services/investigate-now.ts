/**
 * investigateNow (SPEC §2.6, §3.3): explicit requests to investigate one
 * content version.
 *
 * - No investigation yet → admit one funded by the requester (their verified
 *   OpenAI key if they sent one, else the instance key they authenticated
 *   with), with update lineage, and enqueue it.
 * - COMPLETE or FAILED → return it as is. FAILED is terminal (SPEC §3.7).
 * - PROCESSING → return it, after recovering it first if its lease expired.
 * - PENDING and funded → make sure a queue job exists. The requester's key is
 *   never attached: whoever admitted it is already paying for it.
 * - PENDING and unfunded (its user key was dropped) → fund it as above.
 */

import { WORD_COUNT_LIMIT } from "@openerrata/shared";
import type { PrismaClient } from "$lib/db/client";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import {
  fundUnfundedInvestigation,
  insertAdmittedInvestigation,
  type InvestigationFunding,
} from "./investigation-admission.js";
import { buildInvestigationInputSnapshot } from "./investigation-input.js";
import { recoverExpiredLease } from "./investigation-lease.js";
import { enqueueInvestigation } from "./queue.js";
import { resolveUpdateLineage } from "./update-lineage.js";
import { verifyUserOpenAiApiKey, type UserOpenAiKeyVerification } from "./user-key-source.js";

export class InvestigationWordLimitError extends Error {
  readonly limit: number;
  readonly observedWordCount: number;

  constructor(observedWordCount: number, limit: number) {
    super(`Post exceeds word count limit (${limit.toString()} words)`);
    this.name = "InvestigationWordLimitError";
    this.observedWordCount = observedWordCount;
    this.limit = limit;
  }
}

export class UserOpenAiKeyRejectedError extends Error {
  readonly outcome: Extract<UserOpenAiKeyVerification, { verified: false }>["outcome"];

  constructor(outcome: UserOpenAiKeyRejectedError["outcome"]) {
    super(`User OpenAI key was not accepted (${outcome.openaiApiKeyStatus})`);
    this.name = "UserOpenAiKeyRejectedError";
    this.outcome = outcome;
  }
}

/** Who is asking, and therefore who would pay for a run this request admits. */
export type InvestigationRequester =
  | { kind: "INSTANCE_API_KEY" }
  /** The key as sent; it is verified with OpenAI only if it would be attached. */
  | { kind: "USER_OPENAI_KEY"; apiKey: string };

async function fundingFor(requester: InvestigationRequester): Promise<InvestigationFunding> {
  if (requester.kind === "INSTANCE_API_KEY") {
    return { origin: "INSTANCE_REQUEST" };
  }
  const verification = await verifyUserOpenAiApiKey(requester.apiKey);
  if (!verification.verified) {
    throw new UserOpenAiKeyRejectedError(verification.outcome);
  }
  return { origin: "USER_KEY_REQUEST", apiKey: verification.apiKey };
}

/**
 * Handle one investigateNow request and return the id of the investigation for
 * `postVersion`. Throws InvestigationWordLimitError when a new investigation
 * would exceed the word limit, and UserOpenAiKeyRejectedError when a user key
 * would fund the run but OpenAI does not accept it.
 */
export async function requestInvestigation(
  prisma: PrismaClient,
  input: {
    postVersion: {
      id: string;
      postId: string;
      contentBlob: { contentText: string; wordCount: number };
    };
    promptId: string;
    requester: InvestigationRequester;
  },
): Promise<{ investigationId: string }> {
  const { postVersion } = input;
  // A later pass follows a concurrent creation, an expired-lease recovery, or
  // a lost race to fund an unfunded investigation; each re-reads the row.
  for (let pass = 0; pass < 3; pass += 1) {
    const existing = await prisma.investigation.findUnique({
      where: { postVersionId: postVersion.id },
      select: {
        id: true,
        status: true,
        origin: true,
        openAiKeySource: { select: { investigationId: true } },
        lease: { select: { leaseExpiresAt: true } },
      },
    });

    if (existing === null) {
      if (postVersion.contentBlob.wordCount > WORD_COUNT_LIMIT) {
        throw new InvestigationWordLimitError(postVersion.contentBlob.wordCount, WORD_COUNT_LIMIT);
      }
      const lineage = await resolveUpdateLineage(prisma, {
        id: postVersion.id,
        postId: postVersion.postId,
        contentText: postVersion.contentBlob.contentText,
      });
      const snapshot = await buildInvestigationInputSnapshot(prisma, postVersion.id);
      const funding = await fundingFor(input.requester);
      let created: { id: string };
      try {
        created = await prisma.$transaction((tx) =>
          insertAdmittedInvestigation(tx, {
            postVersionId: postVersion.id,
            promptId: input.promptId,
            funding,
            lineage,
            snapshot,
            now: new Date(),
          }),
        );
      } catch (error) {
        if (isUniqueConstraintError(error)) continue;
        throw error;
      }
      await enqueueInvestigation(created.id);
      return { investigationId: created.id };
    }

    switch (existing.status) {
      case "COMPLETE":
      case "FAILED":
        return { investigationId: existing.id };
      case "PROCESSING":
        if (existing.lease !== null && existing.lease.leaseExpiresAt.getTime() <= Date.now()) {
          await recoverExpiredLease(prisma, existing.id);
          continue;
        }
        return { investigationId: existing.id };
      case "PENDING": {
        const unfunded =
          existing.origin === "USER_KEY_REQUEST" && existing.openAiKeySource === null;
        if (unfunded) {
          const funding = await fundingFor(input.requester);
          let funded: boolean;
          try {
            funded = await prisma.$transaction((tx) =>
              fundUnfundedInvestigation(tx, {
                investigationId: existing.id,
                funding,
                now: new Date(),
              }),
            );
          } catch (error) {
            // A concurrent request attached its key first.
            if (isUniqueConstraintError(error)) continue;
            throw error;
          }
          if (!funded) continue;
        }
        await enqueueInvestigation(existing.id);
        return { investigationId: existing.id };
      }
    }
  }

  throw new Error(
    `investigateNow could not settle on an investigation for post version ${postVersion.id}: its state kept changing`,
  );
}
