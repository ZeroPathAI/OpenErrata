import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claimIdSchema,
  extensionPageStatusSchema,
  investigationIdSchema,
  type InvestigationClaim,
  type ViewPostOutput,
} from "@openerrata/shared";
import {
  areClaimsEqual,
  extractDisplayClaimsFromStatus,
  extractDisplayClaimsFromViewPost,
} from "../../src/content/annotation-lifecycle.js";

function makeClaim(id: string): InvestigationClaim {
  return {
    id: claimIdSchema.parse(id),
    text: `Claim ${id}`,
    context: `Context ${id}`,
    summary: `Summary ${id}`,
    reasoning: `Reasoning ${id}`,
    sources: [
      {
        url: `https://example.com/${id}`,
        title: `Source ${id}`,
        snippet: `Snippet ${id}`,
      },
    ],
  };
}

test("areClaimsEqual returns true for equal claim arrays", () => {
  const left = [makeClaim("claim-1"), makeClaim("claim-2")];
  const right = [makeClaim("claim-1"), makeClaim("claim-2")];

  assert.equal(areClaimsEqual(left, right), true);
});

test("areClaimsEqual returns false when source fields differ", () => {
  const left = [makeClaim("claim-1")];
  const right = [
    {
      ...makeClaim("claim-1"),
      sources: [
        {
          url: "https://example.com/claim-1",
          title: "Source claim-1",
          snippet: "Different snippet",
        },
      ],
    },
  ];

  assert.equal(areClaimsEqual(left, right), false);
});

test("extractDisplayClaimsFromViewPost returns investigated claims", () => {
  const claims = [makeClaim("claim-1")];
  const viewPost: ViewPostOutput = {
    investigationState: "INVESTIGATED",
    provenance: "SERVER_VERIFIED",
    claims,
  };

  assert.deepEqual(extractDisplayClaimsFromViewPost(viewPost), claims);
});

test("extractDisplayClaimsFromViewPost falls back to prior investigation old claims", () => {
  const claims = [makeClaim("claim-1")];
  const viewPost: ViewPostOutput = {
    investigationState: "NOT_INVESTIGATED",
    priorInvestigationResult: {
      oldClaims: claims,
      sourceInvestigationId: investigationIdSchema.parse("inv-1"),
    },
  };

  assert.deepEqual(extractDisplayClaimsFromViewPost(viewPost), claims);
});

test("extractDisplayClaimsFromStatus returns null for non-post statuses", () => {
  const status = {
    kind: "SKIPPED",
    tabSessionId: 1,
    platform: "X",
    externalId: "post-1",
    pageUrl: "https://x.com/example/status/1",
    reason: "no_text",
  };

  assert.equal(extractDisplayClaimsFromStatus(extensionPageStatusSchema.parse(status)), null);
});

test("extractDisplayClaimsFromStatus returns prior old claims for in-progress status", () => {
  const claims = [makeClaim("claim-1")];
  const status = {
    kind: "POST",
    tabSessionId: 1,
    platform: "X",
    externalId: "post-1",
    pageUrl: "https://x.com/example/status/1",
    investigationState: "INVESTIGATING",
    status: "PROCESSING",
    provenance: "SERVER_VERIFIED",
    pendingClaims: [],
    confirmedClaims: [],
    priorInvestigationResult: {
      oldClaims: claims,
      sourceInvestigationId: investigationIdSchema.parse("inv-1"),
    },
  };

  assert.deepEqual(extractDisplayClaimsFromStatus(extensionPageStatusSchema.parse(status)), claims);
});
