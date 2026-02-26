import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claimIdSchema,
  investigationIdSchema,
} from "@openerrata/shared";
import {
  snapshotFromInvestigateNowResult,
  toInvestigationStatusForCaching,
} from "../../src/background/investigation-snapshot.js";

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
      claims: null,
    },
    cached,
  );

  assert.equal(snapshot.investigationState, "INVESTIGATING");
  assert.equal(snapshot.status, "PENDING");
  assert.equal(snapshot.provenance, "SERVER_VERIFIED");
  assert.notEqual(snapshot.priorInvestigationResult, null);
  assert.deepEqual(snapshot.priorInvestigationResult?.oldClaims, oldClaims);
  assert.equal(
    snapshot.priorInvestigationResult?.sourceInvestigationId,
    existing.priorInvestigationResult.sourceInvestigationId,
  );
});

test("snapshotFromInvestigateNowResult falls back to empty pending state without update interim", () => {
  const snapshot = snapshotFromInvestigateNowResult(
    {
      investigationId: investigationIdSchema.parse("inv-pending-2"),
      status: "PENDING",
      provenance: "CLIENT_FALLBACK",
      claims: null,
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
