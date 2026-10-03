import assert from "node:assert/strict";
import { test } from "node:test";
import { ExtensionRuntimeError } from "../../src/lib/runtime-error.js";
import {
  NO_SYNC_RETRY,
  hasPendingRetryForSession,
  scheduleSyncRetry,
  syncFailureAction,
} from "../../src/content/sync-retry-policy.js";

const DELAYS = { initialDelayMs: 1_000, maxDelayMs: 30_000 };

test("retries for a session back off exponentially up to the cap", () => {
  const delays: number[] = [];
  let state = NO_SYNC_RETRY;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const scheduled = scheduleSyncRetry(state, "session-1", DELAYS);
    delays.push(scheduled.delayMs);
    state = scheduled.nextState;
  }
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
});

test("a retry for another session starts the backoff over", () => {
  const first = scheduleSyncRetry(NO_SYNC_RETRY, "session-1", DELAYS);
  const second = scheduleSyncRetry(first.nextState, "session-1", DELAYS);
  const other = scheduleSyncRetry(second.nextState, "session-2", DELAYS);
  assert.equal(other.delayMs, 1_000);
  assert.equal(hasPendingRetryForSession(other.nextState, "session-2"), true);
  assert.equal(hasPendingRetryForSession(other.nextState, "session-1"), false);
  assert.equal(hasPendingRetryForSession(NO_SYNC_RETRY, null), false);
});

test("sync failures are retried unless retrying cannot help", () => {
  assert.deepEqual(syncFailureAction(new Error("network")), { kind: "RETRY" });
  assert.deepEqual(
    syncFailureAction(new Error("Could not establish connection. Receiving end does not exist.")),
    { kind: "RETRY" },
  );
  assert.deepEqual(syncFailureAction(new Error("Extension context invalidated.")), {
    kind: "SHUT_DOWN",
  });
  for (const code of [
    "PAYLOAD_TOO_LARGE",
    "UPGRADE_REQUIRED",
    "MALFORMED_EXTENSION_VERSION",
    "INVALID_EXTENSION_MESSAGE",
    "INVALID_EXTENSION_SETTINGS",
  ] as const) {
    assert.deepEqual(syncFailureAction(new ExtensionRuntimeError("no", code)), { kind: "GIVE_UP" });
  }
});
