import assert from "node:assert/strict";
import { test } from "node:test";
import { PLATFORM_VALUES, type Platform } from "@openerrata/shared";
import {
  isLikelyVideoUrl,
  hasXVideoMedia,
  toPromptPostContext,
  resolveHtmlSnapshotsFromVersionMeta,
} from "../../src/lib/services/prompt-context.js";

type PromptPostContextInput = Parameters<typeof toPromptPostContext>[0];

// --- isLikelyVideoUrl ---

test("isLikelyVideoUrl returns true for .mp4 URL", () => {
  assert.equal(isLikelyVideoUrl("https://example.com/video.mp4"), true);
});

test("isLikelyVideoUrl returns true for .webm URL", () => {
  assert.equal(isLikelyVideoUrl("https://example.com/video.webm"), true);
});

test("isLikelyVideoUrl returns true for .m3u8 URL", () => {
  assert.equal(isLikelyVideoUrl("https://example.com/stream.m3u8"), true);
});

test("isLikelyVideoUrl returns true for .mov URL", () => {
  assert.equal(isLikelyVideoUrl("https://example.com/clip.mov"), true);
});

test("isLikelyVideoUrl returns true for .m4v URL", () => {
  assert.equal(isLikelyVideoUrl("https://example.com/clip.m4v"), true);
});

test("isLikelyVideoUrl returns false for .png URL", () => {
  assert.equal(isLikelyVideoUrl("https://example.com/image.png"), false);
});

test("isLikelyVideoUrl returns false for .jpg URL", () => {
  assert.equal(isLikelyVideoUrl("https://example.com/photo.jpg"), false);
});

test("isLikelyVideoUrl returns false for URL without extension", () => {
  assert.equal(isLikelyVideoUrl("https://example.com/page"), false);
});

test("isLikelyVideoUrl works with query strings (uses pathname only)", () => {
  assert.equal(isLikelyVideoUrl("https://example.com/video.mp4?token=abc"), true);
});

test("isLikelyVideoUrl handles malformed URLs gracefully", () => {
  // Malformed URL falls back to the raw string
  assert.equal(isLikelyVideoUrl("not-a-url-video.mp4"), true);
  assert.equal(isLikelyVideoUrl("not-a-url-image.png"), false);
});

test("isLikelyVideoUrl is case insensitive", () => {
  assert.equal(isLikelyVideoUrl("https://example.com/Video.MP4"), true);
  assert.equal(isLikelyVideoUrl("https://example.com/Video.WebM"), true);
});

// --- hasXVideoMedia ---

test("hasXVideoMedia returns true when at least one video URL exists", () => {
  assert.equal(
    hasXVideoMedia(["https://example.com/photo.jpg", "https://example.com/clip.mp4"]),
    true,
  );
});

test("hasXVideoMedia returns false when no video URLs exist", () => {
  assert.equal(
    hasXVideoMedia(["https://example.com/photo.jpg", "https://example.com/img.png"]),
    false,
  );
});

test("hasXVideoMedia returns false for empty array", () => {
  assert.equal(hasXVideoMedia([]), false);
});

// --- toPromptPostContext ---

// Each platform stores its publication timestamp in a different version-meta field.
// This table drives exhaustive coverage: if a platform is added to PLATFORM_VALUES
// without a corresponding entry here, TypeScript will fail to compile the satisfies.

const SAMPLE_TIMESTAMP = new Date("2026-01-02T03:04:05.000Z");

function sampleUrlForPlatform(platform: Platform): string {
  switch (platform) {
    case "LESSWRONG":
      return "https://www.lesswrong.com/posts/example";
    case "X":
      return "https://x.com/u/status/1";
    case "SUBSTACK":
      return "https://example.substack.com/p/test";
    case "WIKIPEDIA":
      return "https://en.wikipedia.org/wiki/Test";
  }
}

const platformTimestampFixtures: Record<
  Platform,
  { input: PromptPostContextInput; hasVideo?: boolean }
> = {
  LESSWRONG: {
    input: {
      serverVerifiedAt: new Date(),
      contentBlob: { contentText: "unused", contentHash: "hash" },
      imageOccurrenceSet: { occurrences: [] },
      lesswrongVersionMeta: {
        serverHtmlBlob: { htmlContent: "<h1>Version Heading</h1>" },
        clientHtmlBlob: { htmlContent: "<h1>Version Heading (client)</h1>" },
        publishedAt: SAMPLE_TIMESTAMP,
      },
      xVersionMeta: null,
      substackVersionMeta: null,
      wikipediaVersionMeta: null,
      post: {
        platform: "LESSWRONG" as const,
        url: sampleUrlForPlatform("LESSWRONG"),
        author: { displayName: "Author Name" },
      },
    } satisfies PromptPostContextInput,
  },
  X: {
    input: {
      serverVerifiedAt: null,
      contentBlob: { contentText: "unused", contentHash: "hash" },
      imageOccurrenceSet: { occurrences: [] },
      lesswrongVersionMeta: null,
      xVersionMeta: {
        postedAt: SAMPLE_TIMESTAMP,
        mediaUrls: ["https://example.com/video.mp4"],
      },
      substackVersionMeta: null,
      wikipediaVersionMeta: null,
      post: {
        platform: "X" as const,
        url: sampleUrlForPlatform("X"),
        author: { displayName: "Author Name" },
      },
    } satisfies PromptPostContextInput,
    hasVideo: true,
  },
  SUBSTACK: {
    input: {
      serverVerifiedAt: null,
      contentBlob: { contentText: "unused", contentHash: "hash" },
      imageOccurrenceSet: { occurrences: [] },
      lesswrongVersionMeta: null,
      xVersionMeta: null,
      substackVersionMeta: {
        publishedAt: SAMPLE_TIMESTAMP,
        serverHtmlBlob: null,
        clientHtmlBlob: { htmlContent: "<h2>Substack Version</h2>" },
      },
      wikipediaVersionMeta: null,
      post: {
        platform: "SUBSTACK" as const,
        url: sampleUrlForPlatform("SUBSTACK"),
        author: { displayName: "Author Name" },
      },
    } satisfies PromptPostContextInput,
  },
  WIKIPEDIA: {
    input: {
      serverVerifiedAt: new Date(),
      contentBlob: { contentText: "unused", contentHash: "hash" },
      imageOccurrenceSet: { occurrences: [] },
      lesswrongVersionMeta: null,
      xVersionMeta: null,
      substackVersionMeta: null,
      wikipediaVersionMeta: {
        lastModifiedAt: SAMPLE_TIMESTAMP,
        serverHtmlBlob: { htmlContent: "<h2>History</h2><p>Version text.</p>" },
        clientHtmlBlob: null,
      },
      post: {
        platform: "WIKIPEDIA" as const,
        url: sampleUrlForPlatform("WIKIPEDIA"),
        author: { displayName: "Author Name" },
      },
    } satisfies PromptPostContextInput,
  },
};

test("toPromptPostContext extracts timestamp from each platform's version meta", () => {
  for (const platform of PLATFORM_VALUES) {
    const { input, hasVideo } = platformTimestampFixtures[platform];
    const ctx = toPromptPostContext(input);
    assert.equal(ctx.platform, platform, `platform=${platform}`);
    assert.equal(ctx.postPublishedAt, SAMPLE_TIMESTAMP.toISOString(), `platform=${platform}`);
    if (hasVideo !== undefined) {
      assert.equal(ctx.hasVideo, hasVideo, `platform=${platform}`);
    }
  }
});

test("toPromptPostContext omits postPublishedAt when platform version meta is absent", () => {
  for (const platform of PLATFORM_VALUES) {
    const ctx = toPromptPostContext({
      serverVerifiedAt: null,
      contentBlob: { contentText: "unused", contentHash: "hash" },
      imageOccurrenceSet: { occurrences: [] },
      lesswrongVersionMeta: null,
      xVersionMeta: null,
      substackVersionMeta: null,
      wikipediaVersionMeta: null,
      post: {
        platform,
        url: sampleUrlForPlatform(platform),
        author: { displayName: "Author Name" },
      },
    });
    assert.equal(ctx.postPublishedAt, undefined, `platform=${platform}`);
  }
});

// --- resolveHtmlSnapshotsFromVersionMeta ---

type HtmlSnapshotsInput = Parameters<typeof resolveHtmlSnapshotsFromVersionMeta>[0];

test("resolveHtmlSnapshotsFromVersionMeta throws when serverVerifiedAt is set but serverHtml is missing", () => {
  const HTML_PLATFORMS: Platform[] = ["LESSWRONG", "SUBSTACK", "WIKIPEDIA"];
  for (const platform of HTML_PLATFORMS) {
    const metaWithMissingServerBlob = {
      serverHtmlBlob: null,
      clientHtmlBlob: { htmlContent: "<p>client</p>" },
    };
    const input: HtmlSnapshotsInput = {
      serverVerifiedAt: new Date("2026-02-20T12:00:00.000Z"),
      contentBlob: { contentText: "unused", contentHash: "hash" },
      imageOccurrenceSet: { occurrences: [] },
      lesswrongVersionMeta:
        platform === "LESSWRONG" ? { publishedAt: null, ...metaWithMissingServerBlob } : null,
      xVersionMeta: null,
      substackVersionMeta:
        platform === "SUBSTACK" ? { publishedAt: null, ...metaWithMissingServerBlob } : null,
      wikipediaVersionMeta:
        platform === "WIKIPEDIA" ? { lastModifiedAt: null, ...metaWithMissingServerBlob } : null,
      post: {
        platform,
        url: sampleUrlForPlatform(platform),
        author: { displayName: "Author" },
      },
    };
    assert.throws(
      () => resolveHtmlSnapshotsFromVersionMeta(input),
      /serverVerifiedAt is set but serverHtml is missing/,
      `platform=${platform}`,
    );
  }
});
