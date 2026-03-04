import assert from "node:assert/strict";
import { test } from "node:test";
import { persistCompletedInvestigation } from "../../src/lib/services/orchestrator.js";
import {
  markInvestigationFailedInTx,
  releaseLeaseToRetryInTx,
} from "../../src/lib/services/attempt-audit.js";
import type { Prisma } from "../../src/lib/generated/prisma/client";
import type { InvestigatorAttemptAudit } from "../../src/lib/investigators/interface.js";

/**
 * Invariants under test:
 *
 * All three terminal/reclaim transaction helpers share the same two-step
 * guard-first pattern:
 *
 * Step 1 — Lease guard: delete the InvestigationLease row matching the
 *   worker's identity. If deleteMany returns 0 (lease already gone — another
 *   worker reclaimed it, or the investigation reached a terminal state), the
 *   function returns false WITHOUT making any further writes.
 *
 * Step 2 — Status invariant: assert that after deleting the lease, the
 *   investigation is still PROCESSING. If not, throw — the lease-existence ↔
 *   PROCESSING structural invariant has been violated. The throw rolls back
 *   the transaction, restoring the lease row, and surfaces the bug loudly.
 *
 * Why these invariants matter:
 * - Without step 1, two workers could both complete the same investigation,
 *   producing duplicate Claim rows (no DB uniqueness constraint on claim text).
 * - Without step 2, a lease could be deleted while the investigation is in an
 *   inconsistent non-PROCESSING state, silently corrupting the lifecycle.
 */

function makeMinimalAttemptAudit(): InvestigatorAttemptAudit {
  return {
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    requestModel: "test-model",
    requestInstructions: "test instructions",
    requestInput: "test input",
    requestReasoningEffort: null,
    requestReasoningSummary: null,
    requestedTools: [],
    response: {
      responseId: "resp_test",
      responseStatus: "completed",
      responseModelVersion: null,
      responseOutputText: null,
      outputItems: [],
      outputTextParts: [],
      outputTextAnnotations: [],
      reasoningSummaries: [],
      toolCalls: [],
      usage: null,
    },
    error: null,
  };
}

function makeClaim() {
  return {
    text: "The earth is flat.",
    context: "In the article the author states the earth is flat.",
    summary: "The earth is not flat.",
    reasoning: "Scientific consensus establishes the earth as an oblate spheroid.",
    sources: [{ url: "https://example.com", title: "Source", snippet: "Evidence" }],
  };
}

test("persistCompletedInvestigation returns false and writes nothing when guard fails", async () => {
  let claimCreateCalled = false;
  let attemptUpsertCalled = false;

  // Mock transaction client where investigationLease.deleteMany returns 0 rows
  // (guard fails). All other methods throw if called — the test fails if any
  // write leaks past the guard.
  const mockTx = {
    investigationLease: {
      deleteMany: async () => ({ count: 0 }),
    },
    investigation: {
      updateMany: async () => {
        throw new Error("Investigation updateMany leaked past guard");
      },
    },
    investigationAttempt: {
      upsert: async () => {
        attemptUpsertCalled = true;
        throw new Error("Attempt audit write leaked past guard");
      },
    },
    claim: {
      create: async () => {
        claimCreateCalled = true;
        throw new Error("Claim write leaked past guard");
      },
    },
  } as unknown as Prisma.TransactionClient;

  const result = await persistCompletedInvestigation(mockTx, {
    investigationId: "inv-test-123",
    workerIdentity: "worker-test-456",
    claims: [makeClaim(), makeClaim()],
    attemptNumber: 1,
    attemptAudit: makeMinimalAttemptAudit(),
    modelVersion: null,
  });

  assert.equal(result, false, "Should return false when guard matches 0 rows");
  assert.equal(claimCreateCalled, false, "claim.create must not be called when guard fails");
  assert.equal(attemptUpsertCalled, false, "attemptAudit must not be written when guard fails");
});

test("persistCompletedInvestigation proceeds to claim writes when guard succeeds", async () => {
  // When the guard matches (count=1), the function must proceed to update
  // investigation status via updateMany. We verify this by checking that
  // investigation.updateMany is called (which happens immediately after the
  // lease guard). Full claim-write verification is covered by integration tests.
  let investigationUpdateManyReached = false;

  const mockTx = {
    investigationLease: {
      deleteMany: async () => ({ count: 1 }),
    },
    investigation: {
      updateMany: async () => {
        investigationUpdateManyReached = true;
        // Return count=1 to indicate the status transition succeeded, then
        // throw on the next call to short-circuit the deeply-mocked path.
        return { count: 1 };
      },
    },
    // persistAttemptAudit calls upsert first — intercept it to stop execution
    // after verifying the guard passed and updateMany was called.
    investigationAttempt: {
      upsert: async () => {
        throw new Error("Mock: stopping after guard verification");
      },
    },
  } as unknown as Prisma.TransactionClient;

  await assert.rejects(
    persistCompletedInvestigation(mockTx, {
      investigationId: "inv-test-123",
      workerIdentity: "worker-test-456",
      claims: [makeClaim()],
      attemptNumber: 1,
      attemptAudit: makeMinimalAttemptAudit(),
      modelVersion: null,
    }),
    /Mock: stopping after guard verification/,
  );

  assert.equal(
    investigationUpdateManyReached,
    true,
    "When guard succeeds (count=1), execution must proceed past the guard to investigation.updateMany",
  );
});

// ── Step-2 invariant: lease deleted but investigation not PROCESSING ──────────
//
// All three tx helpers throw (rolling back the lease deletion) when their
// lease guard succeeds but the subsequent status updateMany matches 0 rows.
// This surfaces broken lease-lifecycle code loudly instead of silently
// leaving the DB in a PROCESSING-with-no-lease zombie state.

test("persistCompletedInvestigation throws invariant error when lease deleted but status is not PROCESSING", async () => {
  const mockTx = {
    investigationLease: {
      deleteMany: async () => ({ count: 1 }), // lease found and deleted
    },
    investigation: {
      updateMany: async () => ({ count: 0 }), // but status was not PROCESSING
    },
  } as unknown as Prisma.TransactionClient;

  await assert.rejects(
    persistCompletedInvestigation(mockTx, {
      investigationId: "inv-test-123",
      workerIdentity: "worker-test-456",
      claims: [],
      attemptNumber: 1,
      attemptAudit: makeMinimalAttemptAudit(),
      modelVersion: null,
    }),
    /Invariant violation.*inv-test-123/,
    "Must throw invariant error when lease exists but investigation is not PROCESSING",
  );
});

test("markInvestigationFailedInTx throws invariant error when lease deleted but status is not PROCESSING", async () => {
  const mockTx = {
    investigationLease: {
      deleteMany: async () => ({ count: 1 }),
    },
    investigation: {
      updateMany: async () => ({ count: 0 }),
    },
  } as unknown as Prisma.TransactionClient;

  await assert.rejects(
    markInvestigationFailedInTx(mockTx, {
      investigationId: "inv-test-789",
      workerIdentity: "worker-test-abc",
      attemptNumber: 1,
      attemptAudit: null,
    }),
    /Invariant violation.*inv-test-789/,
    "Must throw invariant error when lease exists but investigation is not PROCESSING",
  );
});

test("releaseLeaseToRetryInTx throws invariant error when lease deleted but status is not PROCESSING", async () => {
  const mockTx = {
    investigationLease: {
      deleteMany: async () => ({ count: 1 }),
    },
    investigation: {
      updateMany: async () => ({ count: 0 }),
    },
  } as unknown as Prisma.TransactionClient;

  await assert.rejects(
    releaseLeaseToRetryInTx(mockTx, {
      investigationId: "inv-test-def",
      workerIdentity: "worker-test-ghi",
      attemptNumber: 2,
      attemptAudit: null,
      retryAfter: new Date(Date.now() + 20_000),
    }),
    /Invariant violation.*inv-test-def/,
    "Must throw invariant error when lease exists but investigation is not PROCESSING",
  );
});
