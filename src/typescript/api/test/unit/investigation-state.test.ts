import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_STATUS_VALUES } from "@openerrata/shared";
import {
  isRecoverableProcessingRunState,
  recoveredProcessingRunData,
  runTimingForInvestigationStatus,
} from "../../src/lib/services/investigation-state.js";

test("runTimingForInvestigationStatus sets status-specific run timestamps", () => {
  const now = new Date("2026-02-27T12:00:00.000Z");

  type RunTiming = ReturnType<typeof runTimingForInvestigationStatus>;
  const expected = {
    PENDING: { queuedAt: now, startedAt: null, heartbeatAt: null },
    PROCESSING: { queuedAt: null, startedAt: now, heartbeatAt: now },
    COMPLETE: { queuedAt: null, startedAt: null, heartbeatAt: null },
    FAILED: { queuedAt: null, startedAt: null, heartbeatAt: null },
  } satisfies Record<(typeof CHECK_STATUS_VALUES)[number], RunTiming>;

  for (const status of CHECK_STATUS_VALUES) {
    assert.deepEqual(
      runTimingForInvestigationStatus(status, now),
      expected[status],
      `status=${status}`,
    );
  }
});

test("isRecoverableProcessingRunState checks lease and recovery windows correctly", () => {
  const nowMs = Date.parse("2026-02-27T12:00:00.000Z");

  assert.equal(
    isRecoverableProcessingRunState(
      {
        leaseOwner: "worker-1",
        leaseExpiresAt: new Date("2026-02-27T11:59:59.000Z"),
        recoverAfterAt: null,
      },
      nowMs,
    ),
    true,
  );

  assert.equal(
    isRecoverableProcessingRunState(
      {
        leaseOwner: "worker-1",
        leaseExpiresAt: new Date("2026-02-27T12:05:00.000Z"),
        recoverAfterAt: null,
      },
      nowMs,
    ),
    false,
  );

  assert.equal(
    isRecoverableProcessingRunState(
      {
        leaseOwner: null,
        leaseExpiresAt: null,
        recoverAfterAt: new Date("2026-02-27T11:58:00.000Z"),
      },
      nowMs,
    ),
    true,
  );

  assert.equal(
    isRecoverableProcessingRunState(
      {
        leaseOwner: null,
        leaseExpiresAt: null,
        recoverAfterAt: new Date("2026-02-27T12:10:00.000Z"),
      },
      nowMs,
    ),
    false,
  );
});

test("recoveredProcessingRunData clears processing lease state and requeues now", () => {
  const now = new Date("2026-02-27T12:00:00.000Z");

  assert.deepEqual(recoveredProcessingRunData(now), {
    leaseOwner: null,
    leaseExpiresAt: null,
    recoverAfterAt: null,
    heartbeatAt: null,
    queuedAt: now,
  });
});
