import type { ContentProvenance } from "@openerrata/shared";
import type { Investigation } from "$lib/generated/prisma/client";

type RunRecoveryState = {
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  recoverAfterAt: Date | null;
};

type InvestigationRunTiming = {
  queuedAt: Date | null;
  startedAt: Date | null;
  heartbeatAt: Date | null;
};

export function serverVerifiedAtForProvenance(
  provenance: ContentProvenance,
  now: Date = new Date(),
): Date | null {
  return provenance === "SERVER_VERIFIED" ? now : null;
}

export function runTimingForInvestigationStatus(
  status: Investigation["status"],
  now: Date = new Date(),
): InvestigationRunTiming {
  return {
    queuedAt: status === "PENDING" ? now : null,
    startedAt: status === "PROCESSING" ? now : null,
    heartbeatAt: status === "PROCESSING" ? now : null,
  };
}

export function isRecoverableProcessingRunState(
  run: RunRecoveryState,
  nowMs: number = Date.now(),
): boolean {
  if (run.leaseOwner !== null) {
    return run.leaseExpiresAt === null || run.leaseExpiresAt.getTime() <= nowMs;
  }
  return run.recoverAfterAt === null || run.recoverAfterAt.getTime() <= nowMs;
}

export function recoveredProcessingRunData(now: Date = new Date()): {
  leaseOwner: null;
  leaseExpiresAt: null;
  recoverAfterAt: null;
  heartbeatAt: null;
  queuedAt: Date;
} {
  return {
    leaseOwner: null,
    leaseExpiresAt: null,
    recoverAfterAt: null,
    heartbeatAt: null,
    queuedAt: now,
  };
}
