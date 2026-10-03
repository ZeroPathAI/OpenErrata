import assert from "node:assert/strict";
import { test } from "node:test";
import type { Platform } from "@openerrata/shared";
import type { DbClient } from "../../src/lib/db/client.js";
import {
  buildInvestigationInputSnapshot,
  investigationInputRow,
  isLikelyVideoUrl,
} from "../../src/lib/services/investigation-input.js";

/**
 * Invariants under test: the InvestigationInput snapshot captures, at queue
 * time, everything about the post that the prompt uses and that can change
 * later — markdown (with the source URL behind each image placeholder), post
 * URL, author and publication time — and labels the markdown's trust tier.
 */

interface FakePostVersion {
  serverVerifiedAt: Date | null;
  contentBlob: { contentHash: string };
  post: { platform: Platform; url: string; author: { displayName: string } | null };
  lesswrongVersionMeta: null | {
    publishedAt: Date | null;
    serverHtmlBlob: { htmlContent: string } | null;
    clientHtmlBlob: { htmlContent: string } | null;
  };
  xVersionMeta: null | { postedAt: Date | null; mediaUrls: string[] };
  substackVersionMeta: null | {
    publishedAt: Date | null;
    clientHtmlBlob: { htmlContent: string } | null;
  };
  wikipediaVersionMeta: null | {
    lastModifiedAt: Date | null;
    serverHtmlBlob: { htmlContent: string } | null;
    clientHtmlBlob: { htmlContent: string } | null;
  };
}

function fakeDb(postVersion: FakePostVersion): DbClient {
  return {
    postVersion: { findUnique: async () => postVersion },
  } as unknown as DbClient;
}

function basePostVersion(platform: Platform, url: string): FakePostVersion {
  return {
    serverVerifiedAt: null,
    contentBlob: { contentHash: "content-hash" },
    post: { platform, url, author: null },
    lesswrongVersionMeta: null,
    xVersionMeta: null,
    substackVersionMeta: null,
    wikipediaVersionMeta: null,
  };
}

test("LessWrong server-verified snapshot renders server HTML and resolves image sources", async () => {
  const publishedAt = new Date("2026-01-02T03:04:05.000Z");
  const snapshot = await buildInvestigationInputSnapshot(
    fakeDb({
      ...basePostVersion("LESSWRONG", "https://www.lesswrong.com/posts/abc/title"),
      serverVerifiedAt: new Date("2026-01-03T00:00:00.000Z"),
      post: {
        platform: "LESSWRONG",
        url: "https://www.lesswrong.com/posts/abc/title",
        author: { displayName: "Author Name" },
      },
      lesswrongVersionMeta: {
        publishedAt,
        serverHtmlBlob: { htmlContent: '<p>Server text.</p><img src="/img/a.png"/>' },
        clientHtmlBlob: { htmlContent: "<p>Client text.</p>" },
      },
    }),
    "pv-1",
  );

  assert.equal(snapshot.provenance, "SERVER_VERIFIED");
  assert.equal(snapshot.markdown.source, "SERVER_HTML");
  assert.ok(snapshot.markdown.markdown.includes("Server text."));
  assert.ok(snapshot.markdown.markdown.includes("[IMAGE:0]"));
  assert.deepEqual(snapshot.markdown.imageSourceUrls, ["https://www.lesswrong.com/img/a.png"]);
  assert.equal(snapshot.postUrl, "https://www.lesswrong.com/posts/abc/title");
  assert.equal(snapshot.authorName, "Author Name");
  assert.deepEqual(snapshot.postPublishedAt, publishedAt);
  assert.equal(snapshot.hasVideo, false);
});

test("X snapshot has no markdown and flags video media", async () => {
  const postedAt = new Date("2026-02-01T00:00:00.000Z");
  const snapshot = await buildInvestigationInputSnapshot(
    fakeDb({
      ...basePostVersion("X", "https://x.com/someone/status/1"),
      xVersionMeta: {
        postedAt,
        mediaUrls: ["https://video.twimg.com/clip.mp4?tag=12"],
      },
    }),
    "pv-x",
  );

  assert.equal(snapshot.provenance, "CLIENT_FALLBACK");
  assert.deepEqual(snapshot.markdown, { source: "NONE" });
  assert.equal(snapshot.hasVideo, true);
  assert.deepEqual(snapshot.postPublishedAt, postedAt);
  assert.equal(snapshot.authorName, null);
});

test("Substack and Wikipedia snapshots use client HTML and their own timestamps", async () => {
  const substackPublishedAt = new Date("2026-03-01T00:00:00.000Z");
  const substack = await buildInvestigationInputSnapshot(
    fakeDb({
      ...basePostVersion("SUBSTACK", "https://example.substack.com/p/post"),
      substackVersionMeta: {
        publishedAt: substackPublishedAt,
        clientHtmlBlob: { htmlContent: "<p>Substack body.</p>" },
      },
    }),
    "pv-s",
  );
  assert.equal(substack.markdown.source, "CLIENT_HTML");
  assert.deepEqual(substack.postPublishedAt, substackPublishedAt);

  const lastModifiedAt = new Date("2026-04-01T00:00:00.000Z");
  const wikipedia = await buildInvestigationInputSnapshot(
    fakeDb({
      ...basePostVersion("WIKIPEDIA", "https://en.wikipedia.org/wiki/Example"),
      wikipediaVersionMeta: {
        lastModifiedAt,
        serverHtmlBlob: null,
        clientHtmlBlob: { htmlContent: "<p>Wiki body.</p>" },
      },
    }),
    "pv-w",
  );
  assert.equal(wikipedia.markdown.source, "CLIENT_HTML");
  assert.deepEqual(wikipedia.postPublishedAt, lastModifiedAt);
});

test("snapshot refuses a server-verified version without server HTML", async () => {
  await assert.rejects(
    buildInvestigationInputSnapshot(
      fakeDb({
        ...basePostVersion("WIKIPEDIA", "https://en.wikipedia.org/wiki/Example"),
        serverVerifiedAt: new Date(),
        wikipediaVersionMeta: {
          lastModifiedAt: null,
          serverHtmlBlob: null,
          clientHtmlBlob: { htmlContent: "<p>Wiki body.</p>" },
        },
      }),
      "pv-bad",
    ),
    /serverVerifiedAt is set but serverHtml is missing/,
  );
});

test("investigationInputRow stores placeholders only alongside markdown", () => {
  const common = {
    provenance: "CLIENT_FALLBACK" as const,
    contentHash: "hash",
    postUrl: "https://x.com/a/status/1",
    authorName: null,
    postPublishedAt: null,
    hasVideo: false,
  };
  const noMarkdown = investigationInputRow("inv-1", { ...common, markdown: { source: "NONE" } });
  assert.equal(noMarkdown.markdownSource, "NONE");
  assert.deepEqual(noMarkdown.imagePlaceholderSourceUrls, []);
  assert.equal(noMarkdown.markdown, undefined);

  const withMarkdown = investigationInputRow("inv-2", {
    ...common,
    markdown: {
      source: "CLIENT_HTML",
      markdown: "Body [IMAGE:0]",
      rendererVersion: "1.3.0",
      imageSourceUrls: ["https://example.com/a.png"],
    },
  });
  assert.equal(withMarkdown.markdown, "Body [IMAGE:0]");
  assert.deepEqual(withMarkdown.imagePlaceholderSourceUrls, ["https://example.com/a.png"]);
});

test("isLikelyVideoUrl judges by path extension, case-insensitively, ignoring the query", () => {
  for (const url of [
    "https://example.com/video.mp4",
    "https://example.com/video.webm",
    "https://example.com/stream.m3u8",
    "https://example.com/clip.mov",
    "https://example.com/clip.m4v",
    "https://example.com/Video.MP4",
    "https://example.com/video.mp4?token=abc",
  ]) {
    assert.equal(isLikelyVideoUrl(url), true, url);
  }
  for (const url of [
    "https://example.com/image.png",
    "https://example.com/page",
    "https://example.com/page?file=video.mp4",
    "not a url.mp4",
  ]) {
    assert.equal(isLikelyVideoUrl(url), false, url);
  }
});
