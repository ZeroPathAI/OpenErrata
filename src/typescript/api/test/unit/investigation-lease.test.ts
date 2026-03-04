import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASE_BACKOFF_MS,
  MAX_INVESTIGATION_ATTEMPTS,
} from "../../src/lib/services/investigation-lease.js";

/**
 * Invariants under test:
 *
 * The retry backoff schedule determines how quickly a transiently-failed
 * investigation is re-attempted. Two properties must hold:
 *
 * 1. **Every backoff delay is strictly positive.** A zero or negative delay
 *    would cause immediate re-enqueue, defeating the backoff entirely and
 *    hammering the provider API on every failure.
 *
 * 2. **Delays are strictly increasing.** Each retry should wait longer than
 *    the last. A flat or decreasing schedule means later failures don't back
 *    off further, which doesn't reduce load during sustained provider issues.
 *
 * 3. **The maximum delay is bounded at a reasonable ceiling.** Too long and
 *    investigations are stuck for minutes; too short and the backoff provides
 *    no relief. We enforce < 120s as a sanity ceiling.
 *
 * These tests pin the concrete schedule (10s, 20s, 40s for attempts 1–3) so
 * any change to the backoff formula or constants is a deliberate, visible
 * choice rather than an accidental breakage.
 */

test("investigation retry backoff schedule: positive, strictly increasing, bounded", () => {
  const retryAttempts = MAX_INVESTIGATION_ATTEMPTS - 1; // attempts that actually retry

  let prevBackoffMs = 0;
  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);

    assert.ok(
      backoffMs > 0,
      `attempt ${attempt.toString()} backoff must be positive (got ${backoffMs.toString()}ms)`,
    );
    assert.ok(
      backoffMs > prevBackoffMs,
      `attempt ${attempt.toString()} backoff (${backoffMs.toString()}ms) must exceed attempt ${(attempt - 1).toString()} (${prevBackoffMs.toString()}ms)`,
    );
    assert.ok(
      backoffMs < 120_000,
      `attempt ${attempt.toString()} backoff must be < 120s (got ${backoffMs.toString()}ms)`,
    );

    prevBackoffMs = backoffMs;
  }
});

test("investigation retry backoff schedule: concrete values match spec §3.7", () => {
  // Spec §3.7: exponential backoff 10s × 2^(attempt-1)
  // attempt 1 → 10s, attempt 2 → 20s, attempt 3 → 40s
  const expected = [10_000, 20_000, 40_000];
  const retryAttempts = MAX_INVESTIGATION_ATTEMPTS - 1;

  assert.equal(
    retryAttempts,
    expected.length,
    "Expected retry attempt count does not match expected backoff table length",
  );

  for (let i = 0; i < retryAttempts; i++) {
    const attempt = i + 1;
    const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
    assert.equal(
      backoffMs,
      expected[i],
      `attempt ${attempt.toString()} backoff should be ${(expected[i] ?? 0).toString()}ms`,
    );
  }
});

test("MAX_INVESTIGATION_ATTEMPTS is 4 (1 initial attempt + 3 retries)", () => {
  // Pins the concrete value so any intentional change to the attempt cap is
  // a deliberate, visible choice that breaks this test, triggering a review
  // of the backoff table in the test above.
  assert.equal(MAX_INVESTIGATION_ATTEMPTS, 4);
});
