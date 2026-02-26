import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPostStatus,
  createPostStatusFromInvestigation,
  apiErrorToPostStatus,
} from "../../src/background/post-status.js";
import { ApiClientError } from "../../src/background/api-client-error.js";

test("createPostStatus builds CONTENT_MISMATCH without status", () => {
  const status = createPostStatus({
    tabSessionId: 2,
    platform: "LESSWRONG",
    externalId: "lw-2",
    pageUrl: "https://www.lesswrong.com/posts/lw-2/example",
    investigationState: "CONTENT_MISMATCH",
  });

  assert.equal(status.investigationState, "CONTENT_MISMATCH");
  assert.equal("status" in status, false);
});

test("createPostStatusFromInvestigation maps pending status to INVESTIGATING", () => {
  const status = createPostStatusFromInvestigation({
    tabSessionId: 1,
    platform: "X",
    externalId: "123",
    pageUrl: "https://x.com/example/status/123",
    investigationState: "INVESTIGATING",
    status: "PENDING",
    provenance: "CLIENT_FALLBACK",
    claims: null,
    priorInvestigationResult: null,
  });

  assert.equal(status.investigationState, "INVESTIGATING");
  assert.equal(status.status, "PENDING");
  assert.equal(status.claims, null);
  assert.equal(status.priorInvestigationResult, null);
});

test("createPostStatusFromInvestigation maps completed investigation to INVESTIGATED", () => {
  const status = createPostStatusFromInvestigation({
    tabSessionId: 3,
    platform: "LESSWRONG",
    externalId: "lw-3",
    pageUrl: "https://www.lesswrong.com/posts/lw-3/example",
    investigationState: "INVESTIGATED",
    provenance: "SERVER_VERIFIED",
    claims: null,
  });

  assert.equal(status.investigationState, "INVESTIGATED");
  assert.deepEqual(status.claims, []);
});

test("createPostStatusFromInvestigation maps failed status to FAILED", () => {
  const status = createPostStatusFromInvestigation({
    tabSessionId: 4,
    platform: "SUBSTACK",
    externalId: "444",
    pageUrl: "https://example.substack.com/p/sample",
    investigationState: "FAILED",
    provenance: "CLIENT_FALLBACK",
    claims: null,
  });

  assert.equal(status.investigationState, "FAILED");
  assert.equal(status.claims, null);
});

test("createPostStatusFromInvestigation maps undefined status to NOT_INVESTIGATED", () => {
  const status = createPostStatusFromInvestigation({
    tabSessionId: 5,
    platform: "X",
    externalId: "555",
    pageUrl: "https://x.com/example/status/555",
    investigationState: "NOT_INVESTIGATED",
    claims: null,
    priorInvestigationResult: null,
  });

  assert.equal(status.investigationState, "NOT_INVESTIGATED");
  assert.equal("status" in status, false);
  assert.equal(status.claims, null);
  assert.equal(status.priorInvestigationResult, null);
});

test("apiErrorToPostStatus maps CONTENT_MISMATCH ApiClientError to mismatch state", () => {
  const error = new ApiClientError("mismatch", {
    errorCode: "CONTENT_MISMATCH",
  });
  const status = apiErrorToPostStatus({
    error,
    tabSessionId: 1,
    platform: "LESSWRONG",
    externalId: "lw-1",
    pageUrl: "https://www.lesswrong.com/posts/lw-1/example",
  });

  assert.equal(status.investigationState, "CONTENT_MISMATCH");
  assert.equal(status.claims, null);
});

test("apiErrorToPostStatus maps generic errors to FAILED state", () => {
  const status = apiErrorToPostStatus({
    error: new Error("network timeout"),
    tabSessionId: 1,
    platform: "LESSWRONG",
    externalId: "lw-1",
    pageUrl: "https://www.lesswrong.com/posts/lw-1/example",
  });

  assert.equal(status.investigationState, "FAILED");
});

test("apiErrorToPostStatus preserves investigationId and provenance", () => {
  const status = apiErrorToPostStatus({
    error: new Error("server error"),
    tabSessionId: 1,
    platform: "LESSWRONG",
    externalId: "lw-1",
    pageUrl: "https://www.lesswrong.com/posts/lw-1/example",
    investigationId: "inv-123",
    provenance: "SERVER_VERIFIED",
  });

  assert.equal(status.investigationState, "FAILED");
  assert.equal(status.investigationId, "inv-123");
  assert.equal(status.provenance, "SERVER_VERIFIED");
});
