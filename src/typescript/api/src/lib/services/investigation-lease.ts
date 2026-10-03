/**
 * Investigation leases (SPEC §3.7).
 *
 * A worker runs an investigation only while it holds the InvestigationLease
 * row; the database guarantees the row exists iff status = PROCESSING. This
 * module owns every way into and out of that state that is not a run's own
 * outcome: claiming (PENDING → PROCESSING), renewing via heartbeat (and
 * noticing when the lease is gone), recovering expired leases, and releasing
 * a run whose user key turned out to be unusable.
 */

import { getPrisma, type PrismaClient } from "$lib/db/client";
import type { Prisma } from "$lib/db/prisma-client";
import type { InvestigatorAttemptAudit } from "$lib/investigators/interface.js";
import { persistAttemptAudit } from "./attempt-audit.js";
import { unfundedInvestigationWhere } from "./investigation-admission.js";
import { formatErrorForLog } from "./orchestrator-errors.js";
import { consumeOpenAiKeySource } from "./user-key-source.js";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const LEASE_TTL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Attempt cap. A transient failure on attempt MAX_INVESTIGATION_ATTEMPTS (or
 * later), or an expired lease after it, marks the investigation FAILED.
 */
export const MAX_INVESTIGATION_ATTEMPTS = 4;

/** Exponential backoff base for transient retries. */
const BASE_BACKOFF_MS = 10_000;

/**
 * Delay before retrying after transient failure of attempt `attemptNumber`
 * (1-indexed): 10s, 20s, 40s, ...
 */
export function retryBackoffMs(attemptNumber: number): number {
  return BASE_BACKOFF_MS * 2 ** (attemptNumber - 1);
}

function nextLeaseExpiry(now: Date): Date {
  return new Date(now.getTime() + LEASE_TTL_MS);
}

type LeaseClaimResult =
  | { outcome: "CLAIMED"; attemptNumber: number; leaseExpiresAt: Date }
  /** The investigation row is gone (stale job). */
  | { outcome: "MISSING" }
  /** COMPLETE or FAILED. */
  | { outcome: "TERMINAL" }
  /** Another worker holds an unexpired lease. */
  | { outcome: "LEASE_HELD" }
  /** PENDING, but its user key was dropped and nobody has funded it since. */
  | { outcome: "UNFUNDED" };

/**
 * Claim a funded PENDING investigation: PENDING → PROCESSING, increment
 * attemptCount, create the lease. Returns the new attempt number, or null if
 * the investigation was not a funded PENDING investigation.
 */
async function claimFundedPending(
  investigationId: string,
  workerIdentity: string,
): Promise<{ attemptNumber: number; leaseExpiresAt: Date } | null> {
  const now = new Date();
  const leaseExpiresAt = nextLeaseExpiry(now);
  return getPrisma().$transaction(async (tx) => {
    const transitioned = await tx.investigation.updateMany({
      where: {
        id: investigationId,
        status: "PENDING",
        NOT: unfundedInvestigationWhere,
      },
      data: { status: "PROCESSING", attemptCount: { increment: 1 }, retryAfter: null },
    });
    if (transitioned.count === 0) return null;

    await tx.investigationLease.create({
      data: {
        investigationId,
        leaseOwner: workerIdentity,
        leaseExpiresAt,
        startedAt: now,
        heartbeatAt: now,
      },
    });

    const { attemptCount } = await tx.investigation.findUniqueOrThrow({
      where: { id: investigationId },
      select: { attemptCount: true },
    });
    return { attemptNumber: attemptCount, leaseExpiresAt };
  });
}

/**
 * Atomically claim the investigation lease for this worker.
 *
 * Only funded PENDING investigations can be claimed. An expired lease left by
 * a dead worker is recovered first (recoverExpiredLease) and the claim retried,
 * so stale-lease handling has exactly one path.
 *
 * retryAfter is intentionally not checked: it is a selector gate and a queue
 * scheduling hint (enqueueInvestigation's runAt). Once a job reaches a worker —
 * from the scheduled retry or from an explicit investigateNow — it may claim
 * immediately, so investigateNow bypasses the automatic retry delay.
 */
export async function tryClaimLease(
  investigationId: string,
  workerIdentity: string,
): Promise<LeaseClaimResult> {
  const prisma = getPrisma();
  // Two passes: the second follows recovery of an expired lease, or a race in
  // which the row changed between the claim attempt and the classification.
  for (let pass = 0; pass < 2; pass += 1) {
    const claimed = await claimFundedPending(investigationId, workerIdentity);
    if (claimed !== null) {
      return { outcome: "CLAIMED", ...claimed };
    }

    const state = await prisma.investigation.findUnique({
      where: { id: investigationId },
      select: {
        status: true,
        origin: true,
        openAiKeySource: { select: { investigationId: true } },
        lease: { select: { leaseExpiresAt: true } },
      },
    });
    if (state === null) {
      return { outcome: "MISSING" };
    }

    switch (state.status) {
      case "COMPLETE":
      case "FAILED":
        return { outcome: "TERMINAL" };
      case "PENDING":
        if (state.origin === "USER_KEY_REQUEST" && state.openAiKeySource === null) {
          return { outcome: "UNFUNDED" };
        }
        continue;
      case "PROCESSING":
        if (state.lease === null) {
          throw new Error(
            `Investigation ${investigationId} is PROCESSING without a lease row, which the database forbids`,
          );
        }
        if (state.lease.leaseExpiresAt.getTime() > Date.now()) {
          return { outcome: "LEASE_HELD" };
        }
        await recoverExpiredLease(prisma, investigationId);
        continue;
    }
  }

  throw new Error(
    `Could not claim or classify investigation ${investigationId}: its state kept changing`,
  );
}

/**
 * Recover an investigation whose lease expired (its worker died or stalled):
 * delete the lease and return it to PENDING, or mark it FAILED when the lost
 * attempt was the last one allowed. Returns false if there was no expired
 * lease to recover. This is the only stale-lease recovery path; the worker,
 * the selector and investigateNow all use it.
 */
export async function recoverExpiredLease(
  prisma: PrismaClient,
  investigationId: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const deleted = await tx.investigationLease.deleteMany({
      where: { investigationId, leaseExpiresAt: { lte: now } },
    });
    if (deleted.count === 0) {
      return false;
    }

    const { attemptCount } = await tx.investigation.findUniqueOrThrow({
      where: { id: investigationId },
      select: { attemptCount: true },
    });
    if (attemptCount >= MAX_INVESTIGATION_ATTEMPTS) {
      await tx.investigation.update({
        where: { id: investigationId },
        data: { status: "FAILED" },
      });
      await consumeOpenAiKeySource(tx, investigationId);
    } else {
      await tx.investigation.update({
        where: { id: investigationId },
        data: { status: "PENDING", queuedAt: now },
      });
    }
    return true;
  });
}

export class LeaseLostError extends Error {
  constructor(investigationId: string, reason: string) {
    super(`Lost the lease on investigation ${investigationId}: ${reason}`);
    this.name = "LeaseLostError";
  }
}

interface LeaseHeartbeat {
  /**
   * Aborts (with a LeaseLostError reason) once this worker can no longer show
   * it holds the lease: a renewal found no lease row owned by it, or renewals
   * kept failing until the last confirmed expiry passed. Every write the run
   * makes after this aborts would race the lease's new owner.
   */
  readonly leaseLostSignal: AbortSignal;
  stop(): void;
}

/** Renew the lease every HEARTBEAT_INTERVAL_MS until stopped or lost. */
export function startLeaseHeartbeat(
  lease: { investigationId: string; workerIdentity: string; leaseExpiresAt: Date },
  logger: Logger,
): LeaseHeartbeat {
  const prisma = getPrisma();
  const controller = new AbortController();
  let confirmedExpiry = lease.leaseExpiresAt.getTime();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function loseLease(reason: string): void {
    controller.abort(new LeaseLostError(lease.investigationId, reason));
  }

  async function renew(): Promise<void> {
    const now = new Date();
    const renewedExpiry = nextLeaseExpiry(now);
    try {
      const renewed = await prisma.investigationLease.updateMany({
        where: { investigationId: lease.investigationId, leaseOwner: lease.workerIdentity },
        data: { leaseExpiresAt: renewedExpiry, heartbeatAt: now },
      });
      if (renewed.count === 0) {
        loseLease("the lease row is gone or owned by another worker");
        return;
      }
      confirmedExpiry = renewedExpiry.getTime();
    } catch (error) {
      logger.error(
        `Investigation ${lease.investigationId} heartbeat update failed: ${formatErrorForLog(error)}`,
      );
      if (Date.now() >= confirmedExpiry) {
        loseLease("renewals failed until the lease expired");
      }
    }
  }

  function schedule(): void {
    timer = setTimeout(() => {
      void renew().then(() => {
        if (!stopped && !controller.signal.aborted) schedule();
      });
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref();
  }
  schedule();

  return {
    leaseLostSignal: controller.signal,
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}

/**
 * The user key funding this run is unusable (expired, undecryptable, or
 * refused by OpenAI): drop it and return the investigation to PENDING without
 * re-enqueueing. It is now unfunded; the selector or a new request can fund
 * it. The failed attempt is still recorded. Returns false if this worker no
 * longer holds the lease.
 */
export async function releaseLeaseDroppingUserKey(input: {
  investigationId: string;
  workerIdentity: string;
  attemptNumber: number;
  attemptAudit: InvestigatorAttemptAudit | null;
}): Promise<boolean> {
  return getPrisma().$transaction(async (tx) => {
    const released = await tx.investigationLease.deleteMany({
      where: { investigationId: input.investigationId, leaseOwner: input.workerIdentity },
    });
    if (released.count === 0) {
      return false;
    }

    await tx.investigation.update({
      where: { id: input.investigationId },
      data: { status: "PENDING", queuedAt: new Date(), retryAfter: null },
    });
    await consumeOpenAiKeySource(tx, input.investigationId);
    if (input.attemptAudit !== null) {
      await persistAttemptAudit(tx, {
        investigationId: input.investigationId,
        attemptNumber: input.attemptNumber,
        attemptAudit: input.attemptAudit,
      });
    }
    return true;
  });
}

const investigationForRunInclude = {
  input: true,
  postVersion: {
    select: {
      contentBlob: { select: { contentText: true } },
      imageOccurrenceSet: {
        select: {
          occurrences: {
            orderBy: [{ originalIndex: "asc" }],
            select: {
              originalIndex: true,
              normalizedTextOffset: true,
              sourceUrl: true,
              captionText: true,
            },
          },
        },
      },
      post: { select: { platform: true } },
    },
  },
  parentInvestigation: {
    include: {
      claims: {
        include: {
          sources: true,
        },
      },
    },
  },
} satisfies Prisma.InvestigationInclude;

export type InvestigationForRun = Prisma.InvestigationGetPayload<{
  include: typeof investigationForRunInclude;
}>;

/** Everything a claimed run needs: the input snapshot, version text and images, and parent claims. */
export async function loadClaimedInvestigation(
  investigationId: string,
): Promise<InvestigationForRun | null> {
  return getPrisma().investigation.findUnique({
    where: { id: investigationId },
    include: investigationForRunInclude,
  });
}
