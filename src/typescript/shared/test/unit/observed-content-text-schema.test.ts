import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_OBSERVED_CONTENT_TEXT_UTF8_BYTES,
  viewPostInputSchema,
} from "../../src/index.js";

function buildXViewPostInput(observedContentText: string) {
  return {
    platform: "X" as const,
    externalId: "post-1",
    url: "https://x.com/example/status/1",
    observedContentText,
    metadata: {
      authorHandle: "example",
      text: observedContentText,
      mediaUrls: [],
    },
  };
}

test("viewPostInputSchema accepts observedContentText at UTF-8 byte limit", () => {
  const observedContentText = "a".repeat(MAX_OBSERVED_CONTENT_TEXT_UTF8_BYTES);
  const parsed = viewPostInputSchema.parse(buildXViewPostInput(observedContentText));
  assert.equal(parsed.platform, "X");
  assert.equal(parsed.observedContentText.length, observedContentText.length);
});

test("viewPostInputSchema rejects observedContentText over UTF-8 byte limit", () => {
  // U+00E9 encodes to 2 UTF-8 bytes, so this exceeds the byte cap while
  // remaining below the character count cap.
  const observedContentText = "é".repeat(
    Math.floor(MAX_OBSERVED_CONTENT_TEXT_UTF8_BYTES / 2) + 1,
  );
  const parsed = viewPostInputSchema.safeParse(buildXViewPostInput(observedContentText));
  assert.equal(parsed.success, false);
});
