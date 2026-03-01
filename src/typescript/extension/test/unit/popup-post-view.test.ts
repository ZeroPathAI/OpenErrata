import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionPostStatusSchema, type ExtensionPageStatus } from "@openerrata/shared";
import { computePostView } from "../../src/popup/post-view.js";

function createPostStatus(
  investigationState: "FAILED",
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

test("computePostView maps FAILED to popup failed state", () => {
  const status = createPostStatus("FAILED");
  const result = computePostView(status, true);
  assert.deepEqual(result, { kind: "failed" });
});
