import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlatformContent } from "@openerrata/shared";
import { pageSessionKeyFor } from "../../src/content/session-key.js";

function buildXContent(input?: {
  contentText?: string;
  imageOccurrences?: PlatformContent["imageOccurrences"];
  mediaState?: PlatformContent["mediaState"];
}): PlatformContent {
  return {
    platform: "X",
    externalId: "1900000000000000000",
    url: "https://x.com/example/status/1900000000000000000",
    contentText: input?.contentText ?? "Alpha beta gamma",
    mediaState: input?.mediaState ?? "has_images",
    imageUrls: [],
    ...(input?.imageOccurrences === undefined ? {} : { imageOccurrences: input.imageOccurrences }),
    metadata: {
      authorHandle: "example",
      text: input?.contentText ?? "Alpha beta gamma",
      mediaUrls: [],
    },
  };
}

test("pageSessionKeyFor changes when only image occurrence data changes", () => {
  const withFirstImage = buildXContent({
    imageOccurrences: [
      {
        originalIndex: 0,
        normalizedTextOffset: 6,
        sourceUrl: "https://example.com/a.png",
      },
    ],
  });
  const withSecondImage = buildXContent({
    imageOccurrences: [
      {
        originalIndex: 0,
        normalizedTextOffset: 6,
        sourceUrl: "https://example.com/b.png",
      },
    ],
  });

  assert.notEqual(pageSessionKeyFor(withFirstImage), pageSessionKeyFor(withSecondImage));
});

test("pageSessionKeyFor canonicalizes image occurrence ordering", () => {
  const ordered = buildXContent({
    imageOccurrences: [
      {
        originalIndex: 0,
        normalizedTextOffset: 6,
        sourceUrl: "https://example.com/a.png",
      },
      {
        originalIndex: 1,
        normalizedTextOffset: 12,
        sourceUrl: "https://example.com/b.png",
      },
    ],
  });
  const reversedArray = buildXContent({
    imageOccurrences: [
      {
        originalIndex: 1,
        normalizedTextOffset: 12,
        sourceUrl: "https://example.com/b.png",
      },
      {
        originalIndex: 0,
        normalizedTextOffset: 6,
        sourceUrl: "https://example.com/a.png",
      },
    ],
  });

  assert.equal(pageSessionKeyFor(ordered), pageSessionKeyFor(reversedArray));
});

test("pageSessionKeyFor treats undefined and empty image occurrences equally", () => {
  const withoutOccurrences = buildXContent();
  const withEmptyOccurrences = buildXContent({
    imageOccurrences: [],
  });

  assert.equal(pageSessionKeyFor(withoutOccurrences), pageSessionKeyFor(withEmptyOccurrences));
});
