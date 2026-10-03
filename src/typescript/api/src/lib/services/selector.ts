/**
 * Investigation selector (SPEC §2.10, §3.6).
 *
 * Each run, in order:
 * 1. Recovers every investigation whose lease expired (dead or stalled worker).
 * 2. Re-enqueues every funded PENDING investigation that is due, so a lost
 *    queue job never strands one. This is not new spending and is unbudgeted.
 * 3. Admits new work, highest capped unique-view score first: latest post
 *    versions with no investigation, and unfunded investigations (whose user
 *    key was dropped). Admissions are SELECTOR-funded and capped at
 *    SELECTOR_DAILY_BUDGET per UTC day, however often the cron runs.
 *
 * A failure on one candidate is recorded and the run moves on; the run's
 * summary carries the failures so the entrypoint can exit non-zero.
 */

import { getPrisma, type PrismaClient } from "$lib/db/client";
import { startOfUtcDay } from "$lib/date.js";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import type { Prisma } from "$lib/db/prisma-client";
import { WORD_COUNT_LIMIT } from "@openerrata/shared";
import { getOrCreateCurrentPrompt } from "./prompt.js";
import {
  fundUnfundedInvestigation,
  insertAdmittedInvestigation,
  unfundedInvestigationWhere,
} from "./investigation-admission.js";
import { buildInvestigationInputSnapshot } from "./investigation-input.js";
import { recoverExpiredLease } from "./investigation-lease.js";
import { enqueueInvestigation } from "./queue.js";
import { resolveUpdateLineage } from "./update-lineage.js";

interface SelectorFailure {
  stage: "RECOVER" | "REQUEUE" | "ADMIT";
  /** Investigation id for RECOVER/REQUEUE, post version id for ADMIT. */
  subjectId: string;
  error: unknown;
}

interface SelectorRunSummary {
  recovered: number;
  requeued: number;
  admitted: number;
  /** SELECTOR admissions still allowed today after this run. */
  budgetRemaining: number;
  failures: SelectorFailure[];
}

type AdmissionCandidate =
  | { kind: "NEW"; postVersionId: string }
  | { kind: "UNFUNDED"; postVersionId: string; investigationId: string };

/** Serializes budget checks across concurrent selector runs. */
async function lockSelectorBudget(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('openerrata.selector_daily_budget')::bigint)`;
}

async function countSelectorAdmissionsSince(
  db: PrismaClient | Prisma.TransactionClient,
  dayStart: Date,
): Promise<number> {
  return db.investigation.count({
    where: { origin: "SELECTOR", admittedAt: { gte: dayStart } },
  });
}

async function recoverExpiredLeases(
  prisma: PrismaClient,
  failures: SelectorFailure[],
): Promise<number> {
  const expired = await prisma.investigationLease.findMany({
    where: { leaseExpiresAt: { lte: new Date() } },
    select: { investigationId: true },
  });

  let recovered = 0;
  for (const { investigationId } of expired) {
    try {
      if (await recoverExpiredLease(prisma, investigationId)) {
        recovered += 1;
      }
    } catch (error) {
      failures.push({ stage: "RECOVER", subjectId: investigationId, error });
    }
  }
  return recovered;
}

async function requeueDueFundedInvestigations(
  prisma: PrismaClient,
  failures: SelectorFailure[],
): Promise<number> {
  const due = await prisma.investigation.findMany({
    where: {
      status: "PENDING",
      NOT: unfundedInvestigationWhere,
      OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }],
    },
    select: { id: true },
  });

  let requeued = 0;
  for (const { id } of due) {
    try {
      await enqueueInvestigation(id);
      requeued += 1;
    } catch (error) {
      failures.push({ stage: "REQUEUE", subjectId: id, error });
    }
  }
  return requeued;
}

async function loadAdmissionCandidates(
  prisma: PrismaClient,
  limit: number,
): Promise<AdmissionCandidate[]> {
  const rows = await prisma.$queryRaw<
    { postVersionId: string; unfundedInvestigationId: string | null }[]
  >`
    WITH latest_versions AS (
      SELECT DISTINCT ON (pv."postId")
        pv."id" AS "postVersionId",
        pv."postId",
        pv."contentBlobId"
      FROM "PostVersion" pv
      ORDER BY pv."postId", pv."lastSeenAt" DESC, pv."id" DESC
    )
    SELECT
      lv."postVersionId",
      i."id" AS "unfundedInvestigationId"
    FROM latest_versions lv
    JOIN "Post" p ON p."id" = lv."postId"
    JOIN "ContentBlob" cb ON cb."id" = lv."contentBlobId"
    LEFT JOIN "Investigation" i ON i."postVersionId" = lv."postVersionId"
    WHERE cb."wordCount" <= ${WORD_COUNT_LIMIT}
      AND (
        i."id" IS NULL
        OR (
          i."status" = 'PENDING'
          AND i."origin" = 'USER_KEY_REQUEST'
          AND NOT EXISTS (
            SELECT 1 FROM "InvestigationOpenAiKeySource" ks WHERE ks."investigationId" = i."id"
          )
        )
      )
    ORDER BY p."uniqueViewScore" DESC, lv."postVersionId"
    LIMIT ${limit}
  `;

  return rows.map((row) =>
    row.unfundedInvestigationId === null
      ? { kind: "NEW", postVersionId: row.postVersionId }
      : {
          kind: "UNFUNDED",
          postVersionId: row.postVersionId,
          investigationId: row.unfundedInvestigationId,
        },
  );
}

/**
 * Run `admit` in a transaction holding the selector budget lock, but only if
 * fewer than `dailyBudget` SELECTOR admissions happened since `dayStart`.
 * Returns null when the budget is spent or `admit` declined; a unique
 * violation means a request or concurrent run admitted the version first.
 */
async function admitWithinDailyBudget(
  prisma: PrismaClient,
  budget: { dailyBudget: number; dayStart: Date },
  admit: (tx: Prisma.TransactionClient, now: Date) => Promise<string | null>,
): Promise<string | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockSelectorBudget(tx);
      if ((await countSelectorAdmissionsSince(tx, budget.dayStart)) >= budget.dailyBudget) {
        return null;
      }
      return admit(tx, new Date());
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return null;
    }
    throw error;
  }
}

/** Admit one candidate under the daily budget; returns the admitted investigation id. */
async function admitCandidate(
  prisma: PrismaClient,
  input: { candidate: AdmissionCandidate; promptId: string; dailyBudget: number; dayStart: Date },
): Promise<string | null> {
  const { candidate } = input;
  switch (candidate.kind) {
    case "UNFUNDED":
      return admitWithinDailyBudget(prisma, input, async (tx, now) =>
        (await fundUnfundedInvestigation(tx, {
          investigationId: candidate.investigationId,
          funding: { origin: "SELECTOR" },
          now,
        }))
          ? candidate.investigationId
          : null,
      );
    case "NEW": {
      const postVersion = await prisma.postVersion.findUniqueOrThrow({
        where: { id: candidate.postVersionId },
        select: { id: true, postId: true, contentBlob: { select: { contentText: true } } },
      });
      const lineage = await resolveUpdateLineage(prisma, {
        id: postVersion.id,
        postId: postVersion.postId,
        contentText: postVersion.contentBlob.contentText,
      });
      const snapshot = await buildInvestigationInputSnapshot(prisma, postVersion.id);
      return admitWithinDailyBudget(prisma, input, async (tx, now) => {
        const created = await insertAdmittedInvestigation(tx, {
          postVersionId: postVersion.id,
          promptId: input.promptId,
          funding: { origin: "SELECTOR" },
          lineage,
          snapshot,
          now,
        });
        return created.id;
      });
    }
  }
}

/** One selector pass; `dailyBudget` caps SELECTOR admissions per UTC day. */
export async function runSelector(input: { dailyBudget: number }): Promise<SelectorRunSummary> {
  const prisma = getPrisma();
  const { dailyBudget } = input;
  const failures: SelectorFailure[] = [];

  const recovered = await recoverExpiredLeases(prisma, failures);
  const requeued = await requeueDueFundedInvestigations(prisma, failures);

  const dayStart = startOfUtcDay(new Date());
  const remainingAtStart = dailyBudget - (await countSelectorAdmissionsSince(prisma, dayStart));
  let admitted = 0;
  if (remainingAtStart > 0) {
    const prompt = await getOrCreateCurrentPrompt();
    const candidates = await loadAdmissionCandidates(prisma, remainingAtStart);
    for (const candidate of candidates) {
      try {
        const investigationId = await admitCandidate(prisma, {
          candidate,
          promptId: prompt.id,
          dailyBudget,
          dayStart,
        });
        if (investigationId !== null) {
          admitted += 1;
          await enqueueInvestigation(investigationId);
        }
      } catch (error) {
        failures.push({ stage: "ADMIT", subjectId: candidate.postVersionId, error });
      }
    }
  }

  const budgetRemaining = Math.max(
    0,
    dailyBudget - (await countSelectorAdmissionsSince(prisma, dayStart)),
  );
  return { recovered, requeued, admitted, budgetRemaining, failures };
}
