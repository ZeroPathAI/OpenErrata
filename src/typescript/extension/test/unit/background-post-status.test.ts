import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPostStatus,
  viewPostErrorToFailureState,
} from "../../src/background/post-status.js";

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

test("viewPostErrorToFailureState maps mismatch to CONTENT_MISMATCH", () => {
  assert.deepEqual(viewPostErrorToFailureState("CONTENT_MISMATCH"), {
    investigationState: "CONTENT_MISMATCH",
    status: undefined,
    claims: null,
  });
});

test("viewPostErrorToFailureState maps unknown errors to FAILED", () => {
  assert.deepEqual(viewPostErrorToFailureState(undefined), {
    investigationState: "FAILED",
    status: "FAILED",
    claims: null,
  });
});
