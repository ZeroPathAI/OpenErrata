import { getPrisma } from "$lib/db/client";
import { getOrCreateCurrentPrompt } from "./prompt.js";
import { fetchCanonicalContent } from "./content-fetcher.js";
import {
  ensureInvestigationQueued,
  exceedsInvestigationWordLimit,
  wordCount,
} from "./investigation-lifecycle.js";
import {
  WORD_COUNT_LIMIT,
  type Platform,
} from "@openerrata/shared";
import { getSelectorBudget } from "$lib/config/runtime.js";

export async function runSelector(): Promise<number> {
  const prisma = getPrisma();
  const budget = getSelectorBudget();
  const prompt = await getOrCreateCurrentPrompt();

  // Select posts that either have no investigation for the current hash,
  // or are stuck in PENDING and need re-queueing.
  const candidates = await prisma.$queryRaw<
    Array<{
      id: string;
      platform: Platform;
      externalId: string;
      url: string;
      latestContentHash: string;
      latestContentText: string;
    }>
  >`
    SELECT p."id", p."platform", p."externalId", p."url",
           p."latestContentHash", p."latestContentText"
    FROM "Post" p
    LEFT JOIN "Investigation" i
      ON i."postId" = p."id"
     AND i."contentHash" = p."latestContentHash"
    LEFT JOIN "InvestigationRun" r
      ON r."investigationId" = i."id"
    WHERE p."latestContentHash" IS NOT NULL
      AND p."latestContentText" IS NOT NULL
      AND p."wordCount" <= ${WORD_COUNT_LIMIT}
      AND (
        i."id" IS NULL
        OR i."status" = 'PENDING'
        OR (
          i."status" = 'PROCESSING'
          AND (r."id" IS NULL OR r."leaseExpiresAt" IS NULL OR r."leaseExpiresAt" <= NOW())
        )
      )
    ORDER BY p."uniqueViewScore" DESC
    LIMIT ${budget}
  `;

  let enqueued = 0;
  for (const candidate of candidates) {
    let contentHash = candidate.latestContentHash;
    let contentText = candidate.latestContentText;

    const canonical = await fetchCanonicalContent(
      candidate.platform,
      candidate.url,
      candidate.externalId,
    );

    if (canonical.provenance === "SERVER_VERIFIED") {
      contentHash = canonical.contentHash;
      contentText = canonical.contentText;
      await prisma.post.update({
        where: { id: candidate.id },
      data: {
          latestContentHash: contentHash,
          latestContentText: contentText,
          wordCount: wordCount(contentText),
        },
      });
    }

    if (exceedsInvestigationWordLimit(contentText)) {
      continue;
    }

    const { enqueued: wasEnqueued } = await ensureInvestigationQueued({
      prisma,
      postId: candidate.id,
      promptId: prompt.id,
      canonical:
        canonical.provenance === "SERVER_VERIFIED"
          ? {
              contentHash,
              contentText,
              provenance: "SERVER_VERIFIED" as const,
            }
          : {
              contentHash,
              contentText,
              provenance: "CLIENT_FALLBACK" as const,
              fetchFailureReason: canonical.fetchFailureReason,
            },
      rejectOverWordLimitOnCreate: false,
    });

    if (wasEnqueued) {
      enqueued++;
    }
  }

  return enqueued;
}
