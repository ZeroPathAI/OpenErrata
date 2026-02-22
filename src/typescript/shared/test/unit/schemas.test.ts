import assert from "node:assert/strict";
import { test } from "node:test";
import {
  investigationClaimSchema,
  platformContentSchema,
} from "../../src/schemas.js";

function createLesswrongContent() {
  return {
    platform: "LESSWRONG" as const,
    externalId: "lw-123",
    url: "https://www.lesswrong.com/posts/abc123/example",
    contentText: "Example post content",
    mediaState: "text_only",
    imageUrls: [],
    metadata: {
      slug: "example-post",
      htmlContent: "<p>Example post content</p>",
      tags: ["rationality"],
    },
  };
}

function createXContent() {
  return {
    platform: "X" as const,
    externalId: "x-123",
    url: "https://x.com/example/status/123",
    contentText: "Example tweet content",
    mediaState: "has_images",
    imageUrls: ["https://example.com/image.png"],
    metadata: {
      authorHandle: "example",
      text: "Example tweet content",
      mediaUrls: ["https://example.com/image.png"],
      likeCount: 10,
      retweetCount: 2,
    },
  };
}

function createSubstackContent() {
  return {
    platform: "SUBSTACK" as const,
    externalId: "substack-123",
    url: "https://example.substack.com/p/example-post",
    contentText: "Example Substack post content",
    mediaState: "text_only",
    imageUrls: [],
    metadata: {
      substackPostId: "12345",
      publicationSubdomain: "example",
      slug: "example-post",
      title: "Example post",
      authorName: "Example Author",
      likeCount: 10,
      commentCount: 2,
    },
  };
}

test("platformContentSchema parses valid LESSWRONG, X, and SUBSTACK payloads", () => {
  const lesswrongPayload = createLesswrongContent();
  const xPayload = createXContent();
  const substackPayload = createSubstackContent();

  assert.deepEqual(platformContentSchema.parse(lesswrongPayload), lesswrongPayload);
  assert.deepEqual(platformContentSchema.parse(xPayload), xPayload);
  assert.deepEqual(platformContentSchema.parse(substackPayload), substackPayload);
});

test("platformContentSchema allows empty normalized contentText", () => {
  const xPayload = createXContent();
  const payload = {
    ...xPayload,
    contentText: "",
  };

  const parsed = platformContentSchema.parse(payload);
  assert.equal(parsed.contentText, "");
});

test("platformContentSchema rejects LESSWRONG payloads missing htmlContent", () => {
  const lesswrongPayload = createLesswrongContent();
  const { htmlContent, ...metadataWithoutHtml } = lesswrongPayload.metadata;
  void htmlContent;

  const result = platformContentSchema.safeParse({
    ...lesswrongPayload,
    metadata: metadataWithoutHtml,
  });

  assert.equal(result.success, false);
});

test("investigationClaimSchema rejects invalid claim payloads", () => {
  const emptySources = investigationClaimSchema.safeParse({
    text: "Claim text",
    context: "Claim context",
    summary: "Claim summary",
    reasoning: "Claim reasoning",
    sources: [],
  });

  const emptyReasoning = investigationClaimSchema.safeParse({
    text: "Claim text",
    context: "Claim context",
    summary: "Claim summary",
    reasoning: "",
    sources: [
      {
        url: "https://example.com/source",
        title: "Source",
        snippet: "Source snippet",
      },
    ],
  });

  assert.equal(emptySources.success, false);
  assert.equal(emptyReasoning.success, false);
});
