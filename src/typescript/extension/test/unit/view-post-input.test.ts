import assert from "node:assert/strict";
import { test } from "node:test";
import { platformContentSchema, type PlatformContent } from "@openerrata/shared";
import { toViewPostInput } from "../../src/lib/view-post-input.js";

test("toViewPostInput omits observedContentText for LESSWRONG", () => {
  const content: PlatformContent = platformContentSchema.parse({
    platform: "LESSWRONG",
    externalId: "lw1",
    url: "https://www.lesswrong.com/posts/lw1/example",
    contentText: "Observed text from page",
    hasVideo: false,
    imageOccurrences: [],
    metadata: {
      slug: "example",
      htmlContent: "<p>Canonical source</p>",
      tags: ["rationality"],
    },
  });

  const result = toViewPostInput(content);

  assert.equal(result.platform, "LESSWRONG");
  assert.equal("observedContentText" in result, false);
  assert.deepEqual(result.metadata, content.metadata);
});

test("toViewPostInput includes observedContentText for X", () => {
  const content: PlatformContent = platformContentSchema.parse({
    platform: "X",
    externalId: "1900000000000000000",
    url: "https://x.com/example/status/1900000000000000000",
    contentText: "Thread text",
    hasVideo: false,
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
  });

  const result = toViewPostInput(content);

  assert.equal(result.platform, "X");
  assert.equal(result.observedContentText, "Thread text");
  assert.deepEqual(result.observedImageOccurrences, content.imageOccurrences);
  assert.deepEqual(result.metadata, content.metadata);
});

test("toViewPostInput includes observedContentText for SUBSTACK", () => {
  const content: PlatformContent = platformContentSchema.parse({
    platform: "SUBSTACK",
    externalId: "12345",
    url: "https://example.substack.com/p/example-post",
    contentText: "Post body",
    hasVideo: false,
    imageOccurrences: [],
    metadata: {
      substackPostId: "12345",
      publicationSubdomain: "example",
      slug: "example-post",
      title: "Example Post",
      authorName: "Author Name",
    },
  });

  const result = toViewPostInput(content);

  assert.equal(result.platform, "SUBSTACK");
  assert.equal(result.observedContentText, "Post body");
  assert.deepEqual(result.metadata, content.metadata);
});

test("toViewPostInput includes observedContentText for WIKIPEDIA", () => {
  const content: PlatformContent = platformContentSchema.parse({
    platform: "WIKIPEDIA",
    externalId: "en:12345",
    url: "https://en.wikipedia.org/wiki/Climate_change",
    contentText: "Climate change is warming the planet.",
    hasVideo: false,
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
  });

  const result = toViewPostInput(content);

  assert.equal(result.platform, "WIKIPEDIA");
  assert.equal(result.observedContentText, "Climate change is warming the planet.");
  assert.equal("externalId" in result, false);
  assert.deepEqual(result.observedImageOccurrences, content.imageOccurrences);
  assert.deepEqual(result.metadata, content.metadata);
});
