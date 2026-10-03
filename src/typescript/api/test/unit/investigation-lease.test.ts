import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_INVESTIGATION_ATTEMPTS,
  retryBackoffMs,
} from "../../src/lib/services/investigation-lease.js";

/**
 * The retry backoff schedule (SPEC §3.7: 10s × 2^(attempt − 1)) determines how
 * quickly a transiently failed investigation is re-attempted. Pinning the
 * concrete values makes any change to the schedule or the attempt cap a
 * deliberate, visible choice.
 */

test("retryBackoffMs follows 10s × 2^(attempt − 1) for every retried attempt", () => {
  const retriedAttempts = Array.from(
    { length: MAX_INVESTIGATION_ATTEMPTS - 1 },
    (_, index) => index + 1,
  );
  assert.deepEqual(retriedAttempts.map(retryBackoffMs), [10_000, 20_000, 40_000]);
});

test("MAX_INVESTIGATION_ATTEMPTS is 4 (1 initial attempt + 3 retries)", () => {
  assert.equal(MAX_INVESTIGATION_ATTEMPTS, 4);
});
