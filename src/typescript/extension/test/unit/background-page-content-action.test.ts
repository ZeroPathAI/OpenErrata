import assert from "node:assert/strict";
import { test } from "node:test";
import type { InvestigationStatusOutput } from "@openerrata/shared";
import { investigationIdSchema } from "@openerrata/shared";
import { createPostStatusFromInvestigation } from "../../src/background/post-status";
import { decidePageContentPostCacheAction } from "../../src/background/page-content-action";

function buildStatus(snapshot: InvestigationStatusOutput, investigationId?: string) {
  return createPostStatusFromInvestigation({
    tabSessionId: 12,
    platform: "LESSWRONG",
    externalId: "post-1",
    pageUrl: "https://www.lesswrong.com/posts/post-1/example",
    ...(investigationId === undefined ? {} : { investigationId }),
    ...snapshot,
  });
}

test("decidePageContentPostCacheAction resumes polling for INVESTIGATING statuses with investigationId", () => {
  const status = buildStatus(
    {
      investigationState: "INVESTIGATING",
      status: "PROCESSING",
      provenance: "SERVER_VERIFIED",
      claims: null,
      priorInvestigationResult: null,
    },
    investigationIdSchema.parse("inv-1"),
  );

  assert.equal(
    decidePageContentPostCacheAction({
      status,
      shouldAutoInvestigate: false,
    }),
    "RESUME_POLLING",
  );

  assert.equal(
    decidePageContentPostCacheAction({
      status,
      shouldAutoInvestigate: true,
    }),
    "RESUME_POLLING",
  );
});

test("decidePageContentPostCacheAction auto-investigates when eligible and not resumable", () => {
  const status = buildStatus({
    investigationState: "NOT_INVESTIGATED",
    claims: null,
    priorInvestigationResult: null,
  });

  assert.equal(
    decidePageContentPostCacheAction({
      status,
      shouldAutoInvestigate: true,
    }),
    "AUTO_INVESTIGATE",
  );
});

test("decidePageContentPostCacheAction stops polling when not investigating and not auto-investigating", () => {
  const status = buildStatus({
    investigationState: "INVESTIGATED",
    provenance: "SERVER_VERIFIED",
    claims: [],
  });

  assert.equal(
    decidePageContentPostCacheAction({
      status,
      shouldAutoInvestigate: false,
    }),
    "STOP_POLLING",
  );
});
