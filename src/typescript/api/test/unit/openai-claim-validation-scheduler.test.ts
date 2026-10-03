import assert from "node:assert/strict";
import { test } from "node:test";
import { claimIdSchema, type InvestigationResult } from "@openerrata/shared";
import { createClaimValidationScheduler } from "../../src/lib/investigators/openai-claim-validation-scheduler.js";
import {
  createInvestigationRunState,
  getConfirmedClaims,
} from "../../src/lib/investigators/openai-investigation-run-state.js";
import type { ClaimValidationResult } from "../../src/lib/investigators/openai-claim-validator.js";
import { makeValidationRequestAudit } from "../helpers/fake-openai.js";

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

function makeValidationResult(claimIndex: number, approved: boolean): ClaimValidationResult {
  return {
    kind: approved ? "approved" : "rejected",
    claimIndex,
    request: makeValidationRequestAudit(claimIndex),
  };
}

test("claim validation scheduler preserves submission ordering in confirmed claims", async () => {
  const claimA = makeClaim("alpha");
  const claimB = makeClaim("beta");

  const resolvers: ((result: ClaimValidationResult) => void)[] = [];

  const scheduler = createClaimValidationScheduler({
    initialState: createInvestigationRunState({}),
    validationLimiter: async (task) => task(),
    runValidation: async (claimIndex) =>
      new Promise<ClaimValidationResult>((resolve) => {
        resolvers[claimIndex] = resolve;
      }),
  });

  scheduler.scheduleClaimValidation(claimA);
  scheduler.scheduleClaimValidation(claimB);

  const resolveFirst = resolvers[0];
  const resolveSecond = resolvers[1];
  if (!resolveFirst || !resolveSecond) {
    throw new Error("expected validation resolvers to be registered");
  }

  resolveSecond(makeValidationResult(1, true));
  resolveFirst(makeValidationResult(0, true));

  await scheduler.awaitAllValidations();

  assert.deepEqual(getConfirmedClaims(scheduler.getState()), [claimA, claimB]);
});

test("claim validation scheduler retains claims and reports duplicate retention", () => {
  const scheduler = createClaimValidationScheduler({
    initialState: createInvestigationRunState({
      oldClaims: [
        {
          id: claimIdSchema.parse("old-1"),
          ...makeClaim("old-1"),
        },
      ],
    }),
    validationLimiter: async (task) => task(),
    runValidation: async () => makeValidationResult(0, true),
  });

  assert.deepEqual(scheduler.retainClaimById("old-1"), { kind: "ok" });
  assert.deepEqual(scheduler.retainClaimById("old-1"), {
    kind: "error",
    errorMessage: "Claim old-1 already retained",
  });
  assert.deepEqual(scheduler.retainClaimById("missing"), {
    kind: "error",
    errorMessage: "Unknown claim ID: missing",
  });
});
