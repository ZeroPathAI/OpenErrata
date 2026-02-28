import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_OBSERVED_CONTENT_TEXT_UTF8_BYTES, viewPostInputSchema } from "../../src/index.js";

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

function buildWikipediaViewPostInput(observedContentText: string) {
  return {
    platform: "WIKIPEDIA" as const,
    url: "https://en.wikipedia.org/wiki/OpenErrata",
    observedContentText,
    metadata: {
      language: "en",
      title: "OpenErrata",
      pageId: "12345",
      revisionId: "67890",
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
  const observedContentText = "é".repeat(Math.floor(MAX_OBSERVED_CONTENT_TEXT_UTF8_BYTES / 2) + 1);
  const parsed = viewPostInputSchema.safeParse(buildXViewPostInput(observedContentText));
  assert.equal(parsed.success, false);
});

test("viewPostInputSchema accepts Wikipedia input without externalId", () => {
  const parsed = viewPostInputSchema.parse(buildWikipediaViewPostInput("OpenErrata article text"));
  assert.equal(parsed.platform, "WIKIPEDIA");
  assert.equal("externalId" in parsed, false);
});

test("viewPostInputSchema rejects Wikipedia input with client-provided externalId", () => {
  const parsed = viewPostInputSchema.safeParse({
    ...buildWikipediaViewPostInput("OpenErrata article text"),
    externalId: "en:12345",
  });
  assert.equal(parsed.success, false);
});
