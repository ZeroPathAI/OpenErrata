import { getPrisma } from "$lib/db/client";
import type { Prisma } from "$lib/generated/prisma/client";
import { investigationContextInclude } from "./prompt-context.js";
import { formatErrorForLog } from "./orchestrator-errors.js";

export interface Logger {
  info(msg: string): void;
  error(msg: string): void;
}

export const RUN_LEASE_TTL_MS = 60_000;
export const RUN_HEARTBEAT_INTERVAL_MS = 15_000;
export const RUN_RECOVERY_GRACE_MS = 60_000;

export const runContextInclude = {
  investigation: {
    include: {
      ...investigationContextInclude,
      parentInvestigation: {
        include: {
          claims: {
            include: {
              sources: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.InvestigationRunInclude;

export type InvestigationRunWithContext = Prisma.InvestigationRunGetPayload<{
  include: typeof runContextInclude;
}>;

export function nextLeaseExpiry(): Date {
  return new Date(Date.now() + RUN_LEASE_TTL_MS);
}

export function nextRecoveryAfter(): Date {
  return new Date(Date.now() + RUN_RECOVERY_GRACE_MS);
}

export async function tryClaimRunLease(
  runId: string,
  workerIdentity: string,
): Promise<"CLAIMED" | "MISSING" | "TERMINAL" | "LEASE_HELD"> {
  const now = new Date();
  const prisma = getPrisma();
  const claimed = await prisma.investigationRun.updateMany({
    where: {
      id: runId,
      OR: [
        {
          investigation: { is: { status: "PENDING" } },
        },
        {
          investigation: { is: { status: "PROCESSING" } },
          OR: [{ leaseOwner: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
      ],
    },
    data: {
      leaseOwner: workerIdentity,
      leaseExpiresAt: nextLeaseExpiry(),
      recoverAfterAt: null,
      startedAt: now,
      heartbeatAt: now,
    },
  });

  if (claimed.count > 0) {
    return "CLAIMED";
  }

  const run = await prisma.investigationRun.findUnique({
    where: { id: runId },
    select: {
      investigation: { select: { status: true } },
      leaseExpiresAt: true,
    },
  });

  if (!run) return "MISSING";
  if (run.investigation.status === "COMPLETE" || run.investigation.status === "FAILED") {
    return "TERMINAL";
  }
  return "LEASE_HELD";
}

export async function loadClaimedRun(runId: string): Promise<InvestigationRunWithContext | null> {
  return getPrisma().investigationRun.findUnique({
    where: { id: runId },
    include: runContextInclude,
  });
}

export function startRunHeartbeat(
  runId: string,
  workerIdentity: string,
  logger: Logger,
): { stop(): void } {
  const prisma = getPrisma();
  const timer = setInterval(() => {
    void prisma.investigationRun
      .updateMany({
        where: {
          id: runId,
          leaseOwner: workerIdentity,
          investigation: { is: { status: "PROCESSING" } },
        },
        data: {
          leaseExpiresAt: nextLeaseExpiry(),
          recoverAfterAt: null,
          heartbeatAt: new Date(),
        },
      })
      .catch((error: unknown) => {
        logger.error(
          `Investigation run ${runId} heartbeat update failed: ${formatErrorForLog(error)}`,
        );
      });
  }, RUN_HEARTBEAT_INTERVAL_MS);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
