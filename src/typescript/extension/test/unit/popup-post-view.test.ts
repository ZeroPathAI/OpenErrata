import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionPostStatusSchema } from "@openerrata/shared";
import { computePostView } from "../../src/popup/post-view.js";

const baseIdentity = {
  kind: "POST" as const,
  tabSessionId: "00000000-0000-4000-8000-000000000001",
  platform: "LESSWRONG" as const,
  externalId: "lw1",
  pageUrl: "https://www.lesswrong.com/posts/lw1/example",
};

test("computePostView maps FAILED to popup failed state", () => {
  const status = extensionPostStatusSchema.parse({
    ...baseIdentity,
    investigationState: "FAILED",
    investigationId: "investigation-1",
    provenance: "SERVER_VERIFIED",
  });
  const result = computePostView(status, true);
  assert.deepEqual(result, { kind: "failed" });
});

test("computePostView maps API_ERROR to popup failed state", () => {
  const status = extensionPostStatusSchema.parse({
    ...baseIdentity,
    investigationState: "API_ERROR",
  });
  const result = computePostView(status, true);
  assert.deepEqual(result, { kind: "failed" });
});
