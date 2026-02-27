import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRecoverableProcessingRunState,
  recoveredProcessingRunData,
  runTimingForInvestigationStatus,
  serverVerifiedAtForProvenance,
} from "../../src/lib/services/investigation-state.js";

test("serverVerifiedAtForProvenance returns timestamp only for SERVER_VERIFIED", () => {
  const now = new Date("2026-02-27T12:00:00.000Z");

  assert.equal(
    serverVerifiedAtForProvenance("SERVER_VERIFIED", now)?.toISOString(),
    "2026-02-27T12:00:00.000Z",
  );
  assert.equal(serverVerifiedAtForProvenance("CLIENT_FALLBACK", now), null);
});

test("runTimingForInvestigationStatus sets status-specific run timestamps", () => {
  const now = new Date("2026-02-27T12:00:00.000Z");

  assert.deepEqual(runTimingForInvestigationStatus("PENDING", now), {
    queuedAt: now,
    startedAt: null,
    heartbeatAt: null,
  });

  assert.deepEqual(runTimingForInvestigationStatus("PROCESSING", now), {
    queuedAt: null,
    startedAt: now,
    heartbeatAt: now,
  });

  assert.deepEqual(runTimingForInvestigationStatus("FAILED", now), {
    queuedAt: null,
    startedAt: null,
    heartbeatAt: null,
  });
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
