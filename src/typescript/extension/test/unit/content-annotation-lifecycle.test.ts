import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claimIdSchema,
  extensionPageStatusSchema,
  investigationIdSchema,
  type InvestigationClaim,
} from "@openerrata/shared";
import { areClaimsEqual, displayClaimsForStatus } from "../../src/content/annotation-lifecycle.js";

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

test("displayClaimsForStatus shows final claims, else interim claims, else nothing", () => {
  const claims = [makeClaim("claim-1")];
  const prior = {
    oldClaims: [makeClaim("old-1")],
    sourceInvestigationId: investigationIdSchema.parse("old"),
  };
  const base = {
    kind: "POST",
    tabSessionId: "00000000-0000-4000-8000-000000000001",
    platform: "X",
    externalId: "1",
    pageUrl: "https://x.com/a/status/1",
  };
  const parse = (status: object) => {
    const parsed = extensionPageStatusSchema.parse({ ...base, ...status });
    if (parsed.kind !== "POST") throw new Error("expected a post status");
    return parsed;
  };

  assert.deepEqual(
    displayClaimsForStatus(
      parse({
        investigationState: "INVESTIGATED",
        investigationId: "i",
        provenance: "SERVER_VERIFIED",
        claims,
      }),
    ),
    claims,
  );
  assert.deepEqual(
    displayClaimsForStatus(
      parse({ investigationState: "NOT_INVESTIGATED", priorInvestigationResult: prior }),
    ),
    prior.oldClaims,
  );
  assert.deepEqual(
    displayClaimsForStatus(
      parse({
        investigationState: "INVESTIGATING",
        investigationId: "i",
        status: "PENDING",
        provenance: "SERVER_VERIFIED",
        pendingClaims: [],
        confirmedClaims: [],
        priorInvestigationResult: null,
      }),
    ),
    [],
  );
  assert.deepEqual(displayClaimsForStatus(parse({ investigationState: "API_ERROR" })), []);
});
