import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialSyncRetryState,
  hasPendingRetryForSession,
  resolveSyncTrackedSnapshotErrorPolicy,
  scheduleSyncRetry,
  type SyncTrackedSnapshotErrorPolicy,
} from "../../src/content/sync-retry-policy.js";

test("scheduleSyncRetry sets pending session and exponentially increases delay", () => {
  const initial = createInitialSyncRetryState(1_000);
  const first = scheduleSyncRetry(initial, "session-1", 30_000);
  const second = scheduleSyncRetry(first.nextState, "session-1", 30_000);

  assert.equal(first.delayMs, 1_000);
  assert.equal(first.nextState.pendingSessionKey, "session-1");
  assert.equal(first.nextState.nextDelayMs, 2_000);

  assert.equal(second.delayMs, 2_000);
  assert.equal(second.nextState.nextDelayMs, 4_000);
});

test("scheduleSyncRetry caps delay at the configured max", () => {
  const nearMax = {
    pendingSessionKey: null,
    nextDelayMs: 25_000,
  };

  const scheduled = scheduleSyncRetry(nearMax, "session-1", 30_000);
  assert.equal(scheduled.delayMs, 25_000);
  assert.equal(scheduled.nextState.nextDelayMs, 30_000);

  const capped = scheduleSyncRetry(scheduled.nextState, "session-1", 30_000);
  assert.equal(capped.delayMs, 30_000);
  assert.equal(capped.nextState.nextDelayMs, 30_000);
});

test("hasPendingRetryForSession only returns true for matching session key", () => {
  const state = {
    pendingSessionKey: "session-1",
    nextDelayMs: 2_000,
  };

  assert.equal(hasPendingRetryForSession(state, "session-1"), true);
  assert.equal(hasPendingRetryForSession(state, "session-2"), false);
  assert.equal(hasPendingRetryForSession(state, null), false);
});

test("createInitialSyncRetryState clears pending session and restores initial delay", () => {
  assert.deepEqual(createInitialSyncRetryState(1_000), {
    pendingSessionKey: null,
    nextDelayMs: 1_000,
  });
});

test("resolveSyncTrackedSnapshotErrorPolicy picks first matching policy", () => {
  const error = new Error("boom");
  const policies: readonly SyncTrackedSnapshotErrorPolicy[] = [
    {
      matches: (candidate) => candidate === error,
      action: "RESET_ONLY",
    },
    {
      matches: () => true,
      action: "RESET_AND_SYNC_CACHED_FAILURE",
      warningMessage: "fallback",
    },
  ];

  const resolved = resolveSyncTrackedSnapshotErrorPolicy(error, policies);
  assert.notEqual(resolved, null);
  assert.equal(resolved?.action, "RESET_ONLY");
});

test("resolveSyncTrackedSnapshotErrorPolicy returns null when unmatched", () => {
  const resolved = resolveSyncTrackedSnapshotErrorPolicy(new Error("boom"), []);
  assert.equal(resolved, null);
});
