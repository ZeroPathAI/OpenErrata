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
    metadata: {
      authorHandle: "example",
      text: "Thread text",
      mediaUrls: [],
    },
  };

  const result = toViewPostInput(content);

  assert.equal(result.platform, "X");
  assert.equal(result.observedContentText, "Thread text");
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
