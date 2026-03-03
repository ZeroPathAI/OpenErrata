import assert from "node:assert/strict";
import { test } from "node:test";
import { nextRecoveryAfter, runLeaseClaimWhere } from "../../src/lib/services/run-lease.js";

/**
 * Invariants under test:
 *
 * 1. **Recovery window is in the future**: nextRecoveryAfter() must return a
 *    Date after now. If it doesn't, the selector/investigateNow can immediately
 *    re-claim a run that just failed transiently, before graphile-worker's
 *    retry backoff kicks in — causing duplicate processing.
 *
 * 2. **Recovery window is bounded at ~60s**: Too short and retries collide;
 *    too long and investigations are stuck waiting. This pins the grace period.
 *
 * tryClaimRunLease, loadClaimedRun, startRunHeartbeat are Prisma-bound and
 * exercised by the integration test suite.
 */

// ── nextRecoveryAfter ────────────────────────────────────────────────────────

test("nextRecoveryAfter returns a Date in the future", () => {
  const before = Date.now();
  const recovery = nextRecoveryAfter();

  assert.ok(recovery.getTime() > before, "recovery must be after invocation");
});

test("nextRecoveryAfter recovery window is approximately 60 seconds", () => {
  const before = Date.now();
  const recovery = nextRecoveryAfter();
  const deltaMs = recovery.getTime() - before;

  // Allow some clock jitter: between 59s and 61s
  assert.ok(deltaMs >= 59_000, `recovery too soon: ${deltaMs.toString()}ms`);
  assert.ok(deltaMs <= 61_000, `recovery too far: ${deltaMs.toString()}ms`);
});

test("runLeaseClaimWhere requires unheld-or-expired lease for PENDING and PROCESSING runs", () => {
  const now = new Date("2026-03-03T08:00:00.000Z");

  assert.deepEqual(runLeaseClaimWhere("run-123", now), {
    id: "run-123",
    OR: [
      {
        investigation: { is: { status: "PENDING" } },
        OR: [{ leaseOwner: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      {
        investigation: { is: { status: "PROCESSING" } },
        OR: [{ leaseOwner: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
    ],
  });
});
