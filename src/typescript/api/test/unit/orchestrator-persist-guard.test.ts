import assert from "node:assert/strict";
import { test } from "node:test";
import { persistCompletedInvestigation } from "../../src/lib/services/orchestrator.js";
import type { Prisma } from "../../src/lib/generated/prisma/client";
import type { InvestigatorAttemptAudit } from "../../src/lib/investigators/interface.js";

/**
 * Invariant under test:
 *
 * `persistCompletedInvestigation` uses a guard-first pattern: it atomically
 * transitions the investigation from PROCESSING → COMPLETE via updateMany.
 * If updateMany matches 0 rows (investigation already terminal or leased by
 * another worker), the function returns false WITHOUT writing claims or audit.
 *
 * There is no database uniqueness constraint on (investigationId, claim.text),
 * so if the guard is removed or bypassed, duplicate claims silently accumulate.
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
  let runUpdateCalled = false;

  // Mock transaction client where updateMany returns 0 rows (guard fails).
  // All other methods throw if called — the test fails if any write leaks
  // past the guard.
  const mockTx = {
    investigation: {
      updateMany: async () => ({ count: 0 }),
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
    investigationRun: {
      update: async () => {
        runUpdateCalled = true;
        throw new Error("Run update leaked past guard");
      },
    },
  } as unknown as Prisma.TransactionClient;

  const result = await persistCompletedInvestigation(mockTx, {
    investigationId: "inv-test-123",
    runId: "run-test-456",
    claims: [makeClaim(), makeClaim()],
    attemptNumber: 1,
    attemptAudit: makeMinimalAttemptAudit(),
    modelVersion: null,
  });

  assert.equal(result, false, "Should return false when guard matches 0 rows");
  assert.equal(claimCreateCalled, false, "claim.create must not be called when guard fails");
  assert.equal(attemptUpsertCalled, false, "attemptAudit must not be written when guard fails");
  assert.equal(runUpdateCalled, false, "investigationRun must not be updated when guard fails");
});

test("persistCompletedInvestigation proceeds to claim writes when guard succeeds", async () => {
  // When the guard matches (count=1), the function must proceed to write
  // claims. We verify this by checking that persistAttemptAudit is called
  // (which happens immediately after the guard, before claim writes).
  // Full claim-write verification is covered by integration tests with a
  // real database.
  let persistAttemptAuditReached = false;

  const mockTx = {
    investigation: {
      updateMany: async () => ({ count: 1 }),
    },
    // persistAttemptAudit calls upsert first — intercept it to prove
    // execution continued past the guard.
    investigationAttempt: {
      upsert: async () => {
        persistAttemptAuditReached = true;
        // Throw to short-circuit the rest of the deeply-mocked path.
        // The key assertion is that we GOT HERE at all.
        throw new Error("Mock: stopping after guard verification");
      },
    },
  } as unknown as Prisma.TransactionClient;

  await assert.rejects(
    persistCompletedInvestigation(mockTx, {
      investigationId: "inv-test-123",
      runId: "run-test-456",
      claims: [makeClaim()],
      attemptNumber: 1,
      attemptAudit: makeMinimalAttemptAudit(),
      modelVersion: null,
    }),
    /Mock: stopping after guard verification/,
  );

  assert.equal(
    persistAttemptAuditReached,
    true,
    "When guard succeeds (count=1), execution must proceed past the guard to persistAttemptAudit",
  );
});
