import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPostStatus,
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
    claims: null,
  });

  assert.equal(status.investigationState, "CONTENT_MISMATCH");
  assert.equal("status" in status, false);
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
