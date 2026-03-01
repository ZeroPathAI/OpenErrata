import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isLikelyVideoUrl,
  hasXVideoMedia,
  unreachablePlatform,
} from "../../src/lib/services/prompt-context.js";

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

// --- unreachablePlatform ---

test("unreachablePlatform throws with platform name", () => {
  assert.throws(
    () => unreachablePlatform("UNKNOWN_PLATFORM" as never),
    /Unsupported post platform: UNKNOWN_PLATFORM/,
  );
});
