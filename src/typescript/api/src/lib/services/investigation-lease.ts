import { getPrisma } from "$lib/db/client";
import type { Prisma } from "$lib/generated/prisma/client";
import { investigationContextInclude } from "./prompt-context.js";
import { formatErrorForLog } from "./orchestrator-errors.js";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const LEASE_TTL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Maximum number of orchestration attempts before marking FAILED.
 * Each attempt is a full orchestration cycle (claim → investigate → persist).
 * Transient failures reclaim to PENDING and re-enqueue; this cap prevents
 * infinite retry loops.
 */
export const MAX_INVESTIGATION_ATTEMPTS = 4;

/**
 * Exponential backoff base for transient retries, in milliseconds.
 * Delay = BASE_BACKOFF_MS * 2^(attemptCount - 1), so:
 *   attempt 1 → 10s, attempt 2 → 20s, attempt 3 → 40s
 */
export const BASE_BACKOFF_MS = 10_000;

const investigationWithContextInclude = {
  ...investigationContextInclude,
  input: true,
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

type InvestigationWithContext = Prisma.InvestigationGetPayload<{
  include: typeof investigationWithContextInclude;
}>;

function nextLeaseExpiry(): Date {
  return new Date(Date.now() + LEASE_TTL_MS);
}

type LeaseClaimResult =
  | { outcome: "CLAIMED"; attemptNumber: number }
  | { outcome: "MISSING" }
  | { outcome: "TERMINAL" }
  | { outcome: "LEASE_HELD" }
  | { outcome: "ATTEMPTS_EXHAUSTED" };

/**
 * Atomically claim the investigation lease for this worker.
 *
 * The InvestigationLease table structurally enforces that PROCESSING
 * investigations always have a lease holder (the row's existence IS
 * the lease). This function handles two paths:
 *
 * Path 1 (PENDING → PROCESSING): transition investigation status,
 * increment attemptCount, and create a new lease row.
 *
 * Path 2 (stale PROCESSING): delete the expired lease row, increment
 * attemptCount, and create a fresh lease for this worker.
 *
 * Returns the attemptNumber (1-indexed) on CLAIMED so the orchestrator
 * can pass it to the audit trail.
 *
 * Note on retryAfter: this function intentionally does NOT check
 * Investigation.retryAfter before claiming. retryAfter is a selector gate
 * (prevents the cron from re-enqueueing too early) and a graphile-worker
 * scheduling hint (via enqueueInvestigation's runAt). Once a job actually
 * arrives at a worker — whether from the scheduled re-enqueue or from a
 * user-triggered investigateNow call — the worker may claim immediately.
 * This means investigateNow bypasses the backoff window, which is intentional:
 * an explicit user request should not be subject to the automatic retry delay.
 */
export async function tryClaimLease(
  investigationId: string,
  workerIdentity: string,
): Promise<LeaseClaimResult> {
  const now = new Date();
  const prisma = getPrisma();

  // Path 1: PENDING → PROCESSING
  const claimedFromPending = await prisma.$transaction(async (tx) => {
    const transitioned = await tx.investigation.updateMany({
      where: {
        id: investigationId,
        status: "PENDING",
        attemptCount: { lt: MAX_INVESTIGATION_ATTEMPTS },
      },
      data: { status: "PROCESSING", attemptCount: { increment: 1 }, retryAfter: null },
    });
    if (transitioned.count === 0) return null;

    await tx.investigationLease.create({
      data: {
        investigationId,
        leaseOwner: workerIdentity,
        leaseExpiresAt: nextLeaseExpiry(),
        startedAt: now,
        heartbeatAt: now,
      },
    });

    const updated = await tx.investigation.findUnique({
      where: { id: investigationId },
      select: { attemptCount: true },
    });
    return updated?.attemptCount ?? null;
  });

  if (claimedFromPending !== null) {
    return { outcome: "CLAIMED", attemptNumber: claimedFromPending };
  }

  // Check if PENDING but attempts exhausted
  const pendingExhausted = await prisma.investigation.findUnique({
    where: { id: investigationId },
    select: { status: true, attemptCount: true },
  });
  if (
    pendingExhausted?.status === "PENDING" &&
    pendingExhausted.attemptCount >= MAX_INVESTIGATION_ATTEMPTS
  ) {
    return { outcome: "ATTEMPTS_EXHAUSTED" };
  }

  // Path 2: Reclaim stale PROCESSING lease.
  //
  // IMPORTANT: when the deleteMany succeeds but the updateMany guard fails,
  // we must throw (not return) to rollback the transaction. A bare `return null`
  // would commit the lease deletion while leaving the investigation PROCESSING
  // with no InvestigationLease row — a zombie state the selector perpetually
  // re-selects but no worker can ever claim.
  class StaleReclaimAborted extends Error {}
  const reclaimedStale = await prisma
    .$transaction(async (tx) => {
      const deleted = await tx.investigationLease.deleteMany({
        where: { investigationId, leaseExpiresAt: { lte: now } },
      });
      if (deleted.count === 0) return null;

      // Guard: only reclaim if still PROCESSING and under the attempt cap.
      // Throws to rollback the lease deletion if the guard fails — prevents
      // creating a PROCESSING investigation with no lease row.
      const incremented = await tx.investigation.updateMany({
        where: {
          id: investigationId,
          status: "PROCESSING",
          attemptCount: { lt: MAX_INVESTIGATION_ATTEMPTS },
        },
        data: { attemptCount: { increment: 1 } },
      });
      if (incremented.count === 0) {
        throw new StaleReclaimAborted("Guard failed; rolling back lease deletion");
      }

      await tx.investigationLease.create({
        data: {
          investigationId,
          leaseOwner: workerIdentity,
          leaseExpiresAt: nextLeaseExpiry(),
          startedAt: now,
          heartbeatAt: now,
        },
      });

      const updated = await tx.investigation.findUnique({
        where: { id: investigationId },
        select: { attemptCount: true },
      });
      return updated?.attemptCount ?? null;
    })
    .catch((error: unknown) => {
      if (error instanceof StaleReclaimAborted) return null;
      throw error;
    });

  if (reclaimedStale !== null) {
    return { outcome: "CLAIMED", attemptNumber: reclaimedStale };
  }

  // Fallback: determine why we couldn't claim
  const investigation = await prisma.investigation.findUnique({
    where: { id: investigationId },
    select: { status: true, attemptCount: true },
  });
  const lease = await prisma.investigationLease.findUnique({
    where: { investigationId },
    select: { leaseExpiresAt: true },
  });

  if (!investigation) return { outcome: "MISSING" };
  if (investigation.status === "COMPLETE" || investigation.status === "FAILED") {
    return { outcome: "TERMINAL" };
  }
  if (investigation.status === "PROCESSING" && lease !== null && lease.leaseExpiresAt > now) {
    return { outcome: "LEASE_HELD" };
  }
  // PROCESSING with exhausted attempts: stale reclaim was rolled back above.
  // Signal the orchestrator to mark FAILED only when no active lease exists.
  if (
    investigation.status === "PROCESSING" &&
    investigation.attemptCount >= MAX_INVESTIGATION_ATTEMPTS
  ) {
    return { outcome: "ATTEMPTS_EXHAUSTED" };
  }
  return { outcome: "LEASE_HELD" };
}

export async function loadClaimedInvestigation(
  investigationId: string,
): Promise<InvestigationWithContext | null> {
  return getPrisma().investigation.findUnique({
    where: { id: investigationId },
    include: investigationWithContextInclude,
  });
}

export function startHeartbeat(
  investigationId: string,
  workerIdentity: string,
  logger: Logger,
): { stop(): void } {
  const prisma = getPrisma();
  const timer = setInterval(() => {
    void prisma.investigationLease
      .updateMany({
        where: {
          investigationId,
          leaseOwner: workerIdentity,
        },
        data: {
          leaseExpiresAt: nextLeaseExpiry(),
          heartbeatAt: new Date(),
        },
      })
      .catch((error: unknown) => {
        logger.error(
          `Investigation ${investigationId} heartbeat update failed: ${formatErrorForLog(error)}`,
        );
      });
  }, HEARTBEAT_INTERVAL_MS);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
