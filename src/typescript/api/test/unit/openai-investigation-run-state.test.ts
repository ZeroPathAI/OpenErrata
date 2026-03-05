import assert from "node:assert/strict";
import { test } from "node:test";
import { claimIdSchema, type InvestigationResult } from "@openerrata/shared";
import {
  createInvestigationRunState,
  enqueuePendingValidation,
  getConfirmedClaims,
  getPendingClaims,
  retainOldClaim,
  settlePendingValidation,
} from "../../src/lib/investigators/openai-investigation-run-state.js";
import type { PerClaimValidationResult } from "../../src/lib/investigators/openai-claim-validator.js";

function makeClaim(label: string): InvestigationResult["claims"][number] {
  return {
    text: `Claim ${label}`,
    context: `Context ${label}`,
    summary: `Summary ${label}`,
    reasoning: `Reasoning ${label}`,
    sources: [
      {
        url: `https://example.com/${label}`,
        title: `Title ${label}`,
        snippet: `Snippet ${label}`,
      },
    ],
  };
}

function makeValidationResult(input: {
  claimIndex: number;
  approved: boolean;
}): PerClaimValidationResult {
  return {
    claimIndex: input.claimIndex,
    approved: input.approved,
    responseAudit: {
      responseId: "resp-1",
      responseStatus: "completed",
      responseModelVersion: "test-model",
      responseOutputText: JSON.stringify({ approved: input.approved }),
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

test("enqueuePendingValidation + settlePendingValidation tracks pending/confirmed claims", () => {
  const claim = makeClaim("alpha");
  const queued = enqueuePendingValidation(createInvestigationRunState({}), {
    claim,
    promise: Promise.resolve(makeValidationResult({ claimIndex: 0, approved: true })),
  });

  assert.equal(queued.claimIndex, 0);
  assert.deepEqual(getPendingClaims(queued.nextState), [claim]);

  const settled = settlePendingValidation(queued.nextState, {
    pendingIndex: queued.pendingIndex,
    result: makeValidationResult({ claimIndex: 0, approved: true }),
  });

  assert.deepEqual(getPendingClaims(settled), []);
  assert.deepEqual(getConfirmedClaims(settled), [claim]);
});

test("getConfirmedClaims returns submission order even when validations settle out of order", () => {
  const claimA = makeClaim("alpha");
  const claimB = makeClaim("beta");

  const queuedA = enqueuePendingValidation(createInvestigationRunState({}), {
    claim: claimA,
    promise: Promise.resolve(makeValidationResult({ claimIndex: 0, approved: true })),
  });
  const queuedB = enqueuePendingValidation(queuedA.nextState, {
    claim: claimB,
    promise: Promise.resolve(makeValidationResult({ claimIndex: 1, approved: true })),
  });

  const settledBFirst = settlePendingValidation(queuedB.nextState, {
    pendingIndex: queuedB.pendingIndex,
    result: makeValidationResult({ claimIndex: 1, approved: true }),
  });
  const settledBoth = settlePendingValidation(settledBFirst, {
    pendingIndex: queuedA.pendingIndex,
    result: makeValidationResult({ claimIndex: 0, approved: true }),
  });

  assert.deepEqual(getConfirmedClaims(settledBoth), [claimA, claimB]);
});

test("retainOldClaim validates claim id and deduplicates retention", () => {
  const state = createInvestigationRunState({
    oldClaims: [
      {
        id: claimIdSchema.parse("old-1"),
        ...makeClaim("old-1"),
      },
    ],
  });

  const firstRetain = retainOldClaim(state, "old-1");
  if (firstRetain.kind !== "ok") {
    assert.fail("expected retainOldClaim to succeed");
  }

  assert.deepEqual(getConfirmedClaims(firstRetain.nextState), [makeClaim("old-1")]);
  assert.deepEqual(retainOldClaim(firstRetain.nextState, "old-1"), {
    kind: "error",
    reason: "already_retained",
  });
  assert.deepEqual(retainOldClaim(firstRetain.nextState, "missing"), {
    kind: "error",
    reason: "unknown_id",
  });
});
