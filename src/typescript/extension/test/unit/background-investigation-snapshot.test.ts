import assert from "node:assert/strict";
import { test } from "node:test";
import { claimIdSchema, investigationIdSchema } from "@openerrata/shared";
import {
  snapshotFromInvestigateNowResult,
  toInvestigationStatusForCaching,
} from "../../src/background/investigation-snapshot.js";
import { createPostStatusFromInvestigation } from "../../src/background/post-status.js";

test("snapshotFromInvestigateNowResult preserves interim oldClaims while pending", () => {
  const oldClaims = [
    {
      id: claimIdSchema.parse("claim-update-1"),
      text: "Old claim text",
      context: "Context around old claim text",
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
  ];
  const existing = {
    kind: "POST" as const,
    tabSessionId: 7,
    platform: "LESSWRONG" as const,
    externalId: "post-update-1",
    pageUrl: "https://www.lesswrong.com/posts/post-update-1/example",
    investigationState: "NOT_INVESTIGATED" as const,
    claims: null,
    priorInvestigationResult: {
      oldClaims,
      sourceInvestigationId: investigationIdSchema.parse("inv-old-1"),
    },
  };

  const cached = toInvestigationStatusForCaching(existing);
  assert.ok(cached);
  const snapshot = snapshotFromInvestigateNowResult(
    {
      investigationId: investigationIdSchema.parse("inv-new-1"),
      status: "PENDING",
      provenance: "SERVER_VERIFIED",
    },
    cached,
  );

  assert.equal(snapshot.investigationState, "INVESTIGATING");
  assert.equal(snapshot.status, "PENDING");
  assert.equal(snapshot.provenance, "SERVER_VERIFIED");
  const priorResult = snapshot.priorInvestigationResult;
  assert.notEqual(priorResult, null);
  if (priorResult === null) throw new Error("expected priorInvestigationResult");
  assert.deepEqual(priorResult.oldClaims, oldClaims);
  assert.equal(
    priorResult.sourceInvestigationId,
    existing.priorInvestigationResult.sourceInvestigationId,
  );
});

test("snapshotFromInvestigateNowResult falls back to empty pending state without update interim", () => {
  const snapshot = snapshotFromInvestigateNowResult(
    {
      investigationId: investigationIdSchema.parse("inv-pending-2"),
      status: "PENDING",
      provenance: "CLIENT_FALLBACK",
    },
    null,
  );

  assert.equal(snapshot.investigationState, "INVESTIGATING");
  assert.equal(snapshot.status, "PENDING");
  assert.equal(snapshot.provenance, "CLIENT_FALLBACK");
  assert.equal(snapshot.priorInvestigationResult, null);
  assert.equal("claims" in snapshot, true);
  if ("claims" in snapshot) {
    assert.equal(snapshot.claims, null);
  }
});

test("status transition preserves interim oldClaims from NOT_INVESTIGATED to INVESTIGATING", () => {
  const oldClaims = [
    {
      id: claimIdSchema.parse("claim-update-2"),
      text: "Old claim text 2",
      context: "Context around old claim text 2",
      summary: "Old summary 2",
      reasoning: "Old reasoning 2",
      sources: [
        {
          url: "https://example.com/source-2",
          title: "Source 2",
          snippet: "Snippet 2",
        },
      ],
    },
  ];
  const initialStatus = createPostStatusFromInvestigation({
    tabSessionId: 11,
    platform: "LESSWRONG",
    externalId: "post-update-2",
    pageUrl: "https://www.lesswrong.com/posts/post-update-2/example",
    investigationState: "NOT_INVESTIGATED",
    claims: null,
    priorInvestigationResult: {
      oldClaims,
      sourceInvestigationId: investigationIdSchema.parse("inv-old-2"),
    },
  });

  const cachedInitial = toInvestigationStatusForCaching(initialStatus);
  assert.ok(cachedInitial);
  const pendingSnapshot = snapshotFromInvestigateNowResult(
    {
      investigationId: investigationIdSchema.parse("inv-new-2"),
      status: "PENDING",
      provenance: "SERVER_VERIFIED",
    },
    cachedInitial,
  );
  const pendingStatus = createPostStatusFromInvestigation({
    tabSessionId: 11,
    platform: "LESSWRONG",
    externalId: "post-update-2",
    pageUrl: "https://www.lesswrong.com/posts/post-update-2/example",
    investigationId: investigationIdSchema.parse("inv-new-2"),
    ...pendingSnapshot,
  });

  assert.equal(pendingStatus.investigationState, "INVESTIGATING");
  assert.equal(pendingStatus.status, "PENDING");
  const pendingPriorResult = pendingStatus.priorInvestigationResult;
  assert.notEqual(pendingPriorResult, null);
  if (pendingPriorResult === null) throw new Error("expected priorInvestigationResult");
  assert.deepEqual(pendingPriorResult.oldClaims, oldClaims);
  assert.equal(pendingPriorResult.sourceInvestigationId, investigationIdSchema.parse("inv-old-2"));
});
