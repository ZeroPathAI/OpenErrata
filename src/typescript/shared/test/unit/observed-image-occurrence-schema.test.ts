import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKGROUND_REQUESTS,
  MAX_OBSERVED_IMAGE_OCCURRENCES,
  observedImageUrlsFromOccurrences,
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

test("PAGE_CONTENT payload rejects imageOccurrences over limit", () => {
  const result = BACKGROUND_REQUESTS.PAGE_CONTENT.payload.safeParse({
    tabSessionId: "5f0b8d0e-7c55-4c1b-9d0a-1e2f3a4b5c6d",
    content: {
      platform: "X",
      externalId: "1900000000000000000",
      url: "https://x.com/example/status/1900000000000000000",
      contentText: "Hello world",
      hasVideo: false,
      imageOccurrences: buildObservedOccurrences(MAX_OBSERVED_IMAGE_OCCURRENCES + 1),
      metadata: {
        authorHandle: "example",
        text: "Hello world",
        mediaUrls: [],
      },
    },
  });

  assert.equal(result.success, false);
});

test("PAGE_CONTENT payload rejects an external ID in the wrong platform format", () => {
  const result = BACKGROUND_REQUESTS.PAGE_CONTENT.payload.safeParse({
    tabSessionId: "5f0b8d0e-7c55-4c1b-9d0a-1e2f3a4b5c6d",
    content: {
      platform: "SUBSTACK",
      // A Substack slug is not a Substack post ID.
      externalId: "my-post-slug",
      url: "https://example.substack.com/p/my-post-slug",
      contentText: "Hello world",
      hasVideo: false,
      imageOccurrences: [],
      metadata: {
        substackPostId: "123",
        publicationSubdomain: "example",
        slug: "my-post-slug",
        title: "Title",
        authorName: "Author",
      },
    },
  });

  assert.equal(result.success, false);
});

test("observedImageUrlsFromOccurrences lists distinct URLs in page order", () => {
  const occurrences = [
    { originalIndex: 2, normalizedTextOffset: 9, sourceUrl: "https://images.example/a.jpg" },
    { originalIndex: 0, normalizedTextOffset: 0, sourceUrl: "https://images.example/b.jpg" },
    { originalIndex: 1, normalizedTextOffset: 4, sourceUrl: "https://images.example/a.jpg" },
  ];
  assert.deepEqual(observedImageUrlsFromOccurrences(occurrences), [
    "https://images.example/b.jpg",
    "https://images.example/a.jpg",
  ]);
  assert.deepEqual(observedImageUrlsFromOccurrences(undefined), []);
});
