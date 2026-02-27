import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claimIdSchema,
  investigationIdSchema,
  type ExtensionPostStatus,
  type InvestigationStatusOutput,
  type ViewPostOutput,
} from "@openerrata/shared";
import { createPostStatusFromInvestigation } from "../../src/background/post-status";
import { decidePageContentSnapshot } from "../../src/background/page-content-decision";

function buildPriorInvestigationResult() {
  return {
    oldClaims: [
      {
        id: claimIdSchema.parse("claim-old-1"),
        text: "Old claim",
        context: "Old context",
        summary: "Old summary",
        reasoning: "Old reasoning",
        sources: [
          {
            url: "https://example.com/source-1",
            title: "Source 1",
            snippet: "Snippet 1",
          },
        ],
      },
    ],
    sourceInvestigationId: investigationIdSchema.parse("inv-old-1"),
  };
}

function buildExistingStatus(snapshot: InvestigationStatusOutput): ExtensionPostStatus {
  return createPostStatusFromInvestigation({
    tabSessionId: 10,
    platform: "LESSWRONG",
    externalId: "post-1",
    pageUrl: "https://www.lesswrong.com/posts/post-1/example",
    investigationId: investigationIdSchema.parse("inv-current-1"),
    ...snapshot,
  });
}

test("decidePageContentSnapshot preserves INVESTIGATED results and does not auto-investigate", () => {
  const result: ViewPostOutput = {
    investigationState: "INVESTIGATED",
    provenance: "SERVER_VERIFIED",
    claims: [],
  };

  const decision = decidePageContentSnapshot({
    result,
    resultUpdateInterim: null,
    existingForSession: null,
    existingForSessionUpdateInterim: null,
  });

  assert.deepEqual(decision.snapshot, result);
  assert.equal(decision.shouldAutoInvestigate, false);
});

test("decidePageContentSnapshot prefers result interim snapshot when available", () => {
  const priorInvestigationResult = buildPriorInvestigationResult();
  const result: ViewPostOutput = {
    investigationState: "NOT_INVESTIGATED",
    claims: null,
    priorInvestigationResult: priorInvestigationResult,
  };

  const decision = decidePageContentSnapshot({
    result,
    resultUpdateInterim: {
      investigationState: "NOT_INVESTIGATED",
      claims: null,
      priorInvestigationResult: priorInvestigationResult,
    },
    existingForSession: null,
    existingForSessionUpdateInterim: null,
  });

  assert.deepEqual(decision.snapshot, {
    investigationState: "NOT_INVESTIGATED",
    claims: null,
    priorInvestigationResult,
  });
  assert.equal(decision.shouldAutoInvestigate, true);
});

test("decidePageContentSnapshot preserves existing INVESTIGATING status when interim data is available", () => {
  const priorInvestigationResult = buildPriorInvestigationResult();
  const existing = buildExistingStatus({
    investigationState: "INVESTIGATING",
    status: "PROCESSING",
    provenance: "SERVER_VERIFIED",
    claims: null,
    priorInvestigationResult,
  });
  const existingForSessionUpdateInterim: InvestigationStatusOutput = {
    investigationState: "INVESTIGATING",
    status: "PROCESSING",
    provenance: "SERVER_VERIFIED",
    claims: null,
    priorInvestigationResult,
  };
  const result: ViewPostOutput = {
    investigationState: "NOT_INVESTIGATED",
    claims: null,
    priorInvestigationResult: null,
  };

  const decision = decidePageContentSnapshot({
    result,
    resultUpdateInterim: null,
    existingForSession: existing,
    existingForSessionUpdateInterim,
  });

  assert.deepEqual(decision.snapshot, existingForSessionUpdateInterim);
  assert.equal(decision.shouldAutoInvestigate, true);
});

test("decidePageContentSnapshot falls back to synthetic INVESTIGATING snapshot when existing interim is invalid", () => {
  const existing = buildExistingStatus({
    investigationState: "INVESTIGATING",
    status: "PENDING",
    provenance: "SERVER_VERIFIED",
    claims: null,
    priorInvestigationResult: null,
  });
  const result: ViewPostOutput = {
    investigationState: "NOT_INVESTIGATED",
    claims: null,
    priorInvestigationResult: null,
  };

  const decision = decidePageContentSnapshot({
    result,
    resultUpdateInterim: null,
    existingForSession: existing,
    existingForSessionUpdateInterim: null,
  });

  assert.deepEqual(decision.snapshot, {
    investigationState: "INVESTIGATING",
    status: "PENDING",
    provenance: "SERVER_VERIFIED",
    claims: null,
    priorInvestigationResult: null,
  });
  assert.equal(decision.shouldAutoInvestigate, true);
});

test("decidePageContentSnapshot reuses FAILED provenance from existing status", () => {
  const existing = buildExistingStatus({
    investigationState: "FAILED",
    provenance: "CLIENT_FALLBACK",
    claims: null,
  });
  const result: ViewPostOutput = {
    investigationState: "NOT_INVESTIGATED",
    claims: null,
    priorInvestigationResult: null,
  };

  const decision = decidePageContentSnapshot({
    result,
    resultUpdateInterim: null,
    existingForSession: existing,
    existingForSessionUpdateInterim: null,
  });

  assert.deepEqual(decision.snapshot, {
    investigationState: "FAILED",
    provenance: "CLIENT_FALLBACK",
    claims: null,
  });
  assert.equal(decision.shouldAutoInvestigate, true);
});

test("decidePageContentSnapshot falls back to raw result when no preservation path applies", () => {
  const result: ViewPostOutput = {
    investigationState: "INVESTIGATING",
    status: "PENDING",
    provenance: "SERVER_VERIFIED",
    claims: null,
    priorInvestigationResult: null,
  };

  const decision = decidePageContentSnapshot({
    result,
    resultUpdateInterim: null,
    existingForSession: null,
    existingForSessionUpdateInterim: null,
  });

  assert.deepEqual(decision.snapshot, result);
  assert.equal(decision.shouldAutoInvestigate, false);
});
