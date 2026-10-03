import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionPostStatusSchema, xExternalIdSchema } from "@openerrata/shared";
import {
  apiErrorPostStatus,
  postStatusFromInvestigateNow,
  postStatusFromPoll,
  postStatusFromView,
  priorResultOf,
  type PostPage,
} from "../../src/background/post-status.js";
import { claim, investigationId, sessionId } from "../helpers/statuses.js";

const page: PostPage = {
  tabSessionId: sessionId(1),
  platform: "X",
  externalId: xExternalIdSchema.parse("123"),
  pageUrl: "https://x.com/example/status/123",
};

const prior = { oldClaims: [claim("Old claim")], sourceInvestigationId: investigationId("old") };

test("a view of a post under investigation keeps the investigation id to poll", () => {
  const status = postStatusFromView(page, {
    investigationState: "INVESTIGATING",
    investigationId: investigationId("running"),
    status: "PROCESSING",
    provenance: "SERVER_VERIFIED",
    pendingClaims: [],
    confirmedClaims: [],
    priorInvestigationResult: prior,
  });
  assert.deepEqual(extensionPostStatusSchema.parse(status), status);
  assert.equal(status.investigationState === "INVESTIGATING" && status.investigationId, "running");
  assert.deepEqual(priorResultOf(status), prior);
});

test("investigateNow statuses carry over the interim claims the page showed", () => {
  const pending = postStatusFromInvestigateNow(
    page,
    { investigationId: investigationId("new"), status: "PENDING", provenance: "SERVER_VERIFIED" },
    prior,
  );
  assert.equal(pending.investigationState, "INVESTIGATING");
  assert.deepEqual(priorResultOf(pending), prior);

  const failed = postStatusFromInvestigateNow(
    page,
    { investigationId: investigationId("new"), status: "FAILED", provenance: "SERVER_VERIFIED" },
    prior,
  );
  assert.deepEqual(failed, {
    kind: "POST",
    ...page,
    investigationState: "FAILED",
    investigationId: "new",
    provenance: "SERVER_VERIFIED",
  });
});

test("poll results become statuses of the polled investigation", () => {
  const settled = postStatusFromPoll(page, investigationId("polled"), {
    investigationState: "INVESTIGATED",
    provenance: "CLIENT_FALLBACK",
    claims: [claim("A claim")],
    checkedAt: "2026-10-02T00:00:00.000Z",
  });
  assert.deepEqual(settled, {
    kind: "POST",
    ...page,
    investigationState: "INVESTIGATED",
    investigationId: "polled",
    provenance: "CLIENT_FALLBACK",
    claims: [claim("A claim")],
  });
});

test("an API failure is reported as API_ERROR, never as a failed investigation", () => {
  assert.deepEqual(apiErrorPostStatus(page), {
    kind: "POST",
    ...page,
    investigationState: "API_ERROR",
  });
});
