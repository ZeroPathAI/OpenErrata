import { getPrisma } from "$lib/db/client";
import { getOrCreateCurrentPrompt } from "./prompt.js";
import { ensureInvestigationQueued } from "./investigation-lifecycle.js";
import { WORD_COUNT_LIMIT } from "@openerrata/shared";
import { getSelectorBudget } from "$lib/config/runtime.js";

export async function runSelector(): Promise<number> {
  const prisma = getPrisma();
  const budget = getSelectorBudget();
  const prompt = await getOrCreateCurrentPrompt();

  // Consider the most recently seen version for each post and enqueue
  // investigations that are missing or in recoverable pending/processing states.
  const candidates = await prisma.$queryRaw<
    Array<{
      postVersionId: string;
      investigationId: string | null;
      investigationStatus: "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED" | null;
      runId: string | null;
      leaseOwner: string | null;
      leaseExpiresAt: Date | null;
      recoverAfterAt: Date | null;
    }>
  >`
    WITH latest_versions AS (
      SELECT DISTINCT ON (pv."postId")
        pv."id" AS "postVersionId",
        pv."postId",
        pv."contentBlobId",
        pv."lastSeenAt"
      FROM "PostVersion" pv
      ORDER BY pv."postId", pv."lastSeenAt" DESC, pv."id" DESC
    )
    SELECT
      lv."postVersionId",
      i."id" AS "investigationId",
      i."status" AS "investigationStatus",
      r."id" AS "runId",
      r."leaseOwner",
      r."leaseExpiresAt",
      r."recoverAfterAt"
    FROM latest_versions lv
    JOIN "Post" p
      ON p."id" = lv."postId"
    JOIN "ContentBlob" cb
      ON cb."id" = lv."contentBlobId"
    LEFT JOIN "Investigation" i
      ON i."postVersionId" = lv."postVersionId"
    LEFT JOIN "InvestigationRun" r
      ON r."investigationId" = i."id"
    WHERE cb."wordCount" <= ${WORD_COUNT_LIMIT}
      AND (
      i."id" IS NULL
      OR i."status" = 'PENDING'
      OR (
        i."status" = 'PROCESSING'
        AND (
          r."id" IS NULL
          OR (
            r."leaseOwner" IS NOT NULL
            AND (r."leaseExpiresAt" IS NULL OR r."leaseExpiresAt" <= NOW())
          )
          OR (
            r."leaseOwner" IS NULL
            AND (r."recoverAfterAt" IS NULL OR r."recoverAfterAt" <= NOW())
          )
        )
      )
    )
    ORDER BY p."uniqueViewScore" DESC
    LIMIT ${budget}
  `;

  let enqueued = 0;
  for (const candidate of candidates) {
    const { enqueued: wasEnqueued } = await ensureInvestigationQueued({
      prisma,
      postVersionId: candidate.postVersionId,
      promptId: prompt.id,
      rejectOverWordLimitOnCreate: false,
    });

    if (wasEnqueued) {
      enqueued += 1;
    }
  }

  return enqueued;
}
