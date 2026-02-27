import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlatformContent } from "@openerrata/shared";
import { toViewPostInput } from "../../src/lib/view-post-input.js";

test("toViewPostInput omits observedContentText for LESSWRONG", () => {
  const content: PlatformContent = {
    platform: "LESSWRONG",
    externalId: "lw-1",
    url: "https://www.lesswrong.com/posts/lw-1/example",
    contentText: "Observed text from page",
    mediaState: "text_only",
    imageUrls: [],
    imageOccurrences: [],
    metadata: {
      slug: "example",
      htmlContent: "<p>Canonical source</p>",
      tags: ["rationality"],
    },
  };

  const result = toViewPostInput(content);

  assert.equal(result.platform, "LESSWRONG");
  assert.equal("observedContentText" in result, false);
  assert.deepEqual(result.metadata, content.metadata);
});

test("toViewPostInput includes observedContentText for X", () => {
  const content: PlatformContent = {
    platform: "X",
    externalId: "1900000000000000000",
    url: "https://x.com/example/status/1900000000000000000",
    contentText: "Thread text",
    mediaState: "text_only",
    imageUrls: [],
    imageOccurrences: [
      {
        originalIndex: 0,
        normalizedTextOffset: 7,
        sourceUrl: "https://example.com/image.png",
      },
    ],
    metadata: {
      authorHandle: "example",
      text: "Thread text",
      mediaUrls: [],
    },
  };

  const result = toViewPostInput(content);

  assert.equal(result.platform, "X");
  assert.equal(result.observedContentText, "Thread text");
  assert.deepEqual(result.observedImageOccurrences, content.imageOccurrences);
  assert.deepEqual(result.metadata, content.metadata);
});

test("toViewPostInput includes observedContentText for SUBSTACK", () => {
  const content: PlatformContent = {
    platform: "SUBSTACK",
    externalId: "example-post",
    url: "https://example.substack.com/p/example-post",
    contentText: "Post body",
    mediaState: "text_only",
    imageUrls: [],
    imageOccurrences: [],
    metadata: {
      substackPostId: "12345",
      publicationSubdomain: "example",
      slug: "example-post",
      title: "Example Post",
      authorName: "Author Name",
    },
  };

  const result = toViewPostInput(content);

  assert.equal(result.platform, "SUBSTACK");
  assert.equal(result.observedContentText, "Post body");
  assert.deepEqual(result.metadata, content.metadata);
});

test("toViewPostInput includes observedContentText for WIKIPEDIA", () => {
  const content: PlatformContent = {
    platform: "WIKIPEDIA",
    externalId: "en:12345",
    url: "https://en.wikipedia.org/wiki/Climate_change",
    contentText: "Climate change is warming the planet.",
    mediaState: "text_only",
    imageUrls: [],
    imageOccurrences: [
      {
        originalIndex: 0,
        normalizedTextOffset: 9,
        sourceUrl: "https://upload.wikimedia.org/example.jpg",
      },
    ],
    metadata: {
      language: "en",
      title: "Climate_change",
      pageId: "12345",
      revisionId: "67890",
      displayTitle: "Climate change",
    },
  };

  const result = toViewPostInput(content);

  assert.equal(result.platform, "WIKIPEDIA");
  assert.equal(result.observedContentText, "Climate change is warming the planet.");
  assert.deepEqual(result.observedImageOccurrences, content.imageOccurrences);
  assert.deepEqual(result.metadata, content.metadata);
});
