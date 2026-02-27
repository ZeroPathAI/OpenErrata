import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionPostStatusSchema, type ExtensionPageStatus } from "@openerrata/shared";
import { computePostView } from "../../src/popup/post-view.js";

function createPostStatus(
  investigationState: "FAILED" | "CONTENT_MISMATCH",
): Extract<ExtensionPageStatus, { kind: "POST" }> {
  return extensionPostStatusSchema.parse({
    kind: "POST",
    tabSessionId: 1,
    platform: "LESSWRONG",
    externalId: "lw-1",
    pageUrl: "https://www.lesswrong.com/posts/lw-1/example",
    investigationState,
    claims: null,
  });
}

test("computePostView maps CONTENT_MISMATCH to popup mismatch state", () => {
  const status = createPostStatus("CONTENT_MISMATCH");
  const result = computePostView(status, true);
  assert.deepEqual(result, { kind: "content_mismatch" });
});

test("computePostView maps FAILED to popup failed state", () => {
  const status = createPostStatus("FAILED");
  const result = computePostView(status, true);
  assert.deepEqual(result, { kind: "failed" });
});
