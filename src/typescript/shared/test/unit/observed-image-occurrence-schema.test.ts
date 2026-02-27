import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_OBSERVED_IMAGE_OCCURRENCES,
  extensionMessageSchema,
  viewPostInputSchema,
} from "../../src/index.js";

function buildObservedOccurrences(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    originalIndex: index,
    normalizedTextOffset: index * 3,
    sourceUrl: `https://images.example/${index.toString()}.jpg`,
  }));
}

test("viewPostInputSchema accepts observedImageOccurrences at limit", () => {
  const result = viewPostInputSchema.safeParse({
    platform: "X",
    externalId: "1900000000000000000",
    url: "https://x.com/example/status/1900000000000000000",
    observedContentText: "Hello world",
    observedImageOccurrences: buildObservedOccurrences(MAX_OBSERVED_IMAGE_OCCURRENCES),
    metadata: {
      authorHandle: "example",
      text: "Hello world",
      mediaUrls: [],
    },
  });

  assert.equal(result.success, true);
});

test("viewPostInputSchema rejects observedImageOccurrences over limit", () => {
  const result = viewPostInputSchema.safeParse({
    platform: "X",
    externalId: "1900000000000000000",
    url: "https://x.com/example/status/1900000000000000000",
    observedContentText: "Hello world",
    observedImageOccurrences: buildObservedOccurrences(MAX_OBSERVED_IMAGE_OCCURRENCES + 1),
    metadata: {
      authorHandle: "example",
      text: "Hello world",
      mediaUrls: [],
    },
  });

  assert.equal(result.success, false);
});

test("extensionMessageSchema rejects PAGE_CONTENT imageOccurrences over limit", () => {
  const result = extensionMessageSchema.safeParse({
    v: 1,
    type: "PAGE_CONTENT",
    payload: {
      tabSessionId: 1,
      content: {
        platform: "X",
        externalId: "1900000000000000000",
        url: "https://x.com/example/status/1900000000000000000",
        contentText: "Hello world",
        mediaState: "has_images",
        imageUrls: [],
        imageOccurrences: buildObservedOccurrences(MAX_OBSERVED_IMAGE_OCCURRENCES + 1),
        metadata: {
          authorHandle: "example",
          text: "Hello world",
          mediaUrls: [],
        },
      },
    },
  });

  assert.equal(result.success, false);
});
