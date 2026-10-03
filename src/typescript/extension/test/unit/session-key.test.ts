import assert from "node:assert/strict";
import { test } from "node:test";
import { xExternalIdSchema, type PlatformContent } from "@openerrata/shared";
import type { PlatformAdapter } from "../../src/content/adapters/index.js";
import { excludeNothing } from "../../src/content/adapters/model.js";

const STUB_ADAPTER: PlatformAdapter = {
  platformKey: "LESSWRONG",
  matches: () => true,
  pageLocator: () => null,
  extract: () => ({ kind: "not_ready", reason: "hydrating" }),
  getContentRoot: () => null,
  contentExclusionFilter: excludeNothing,
};
import { pageLocatorFor } from "../../src/lib/page-locator.js";
import { sessionKeyFor } from "../../src/content/session-key.js";
import type { PageSnapshot } from "../../src/content/session-state.js";

function xContent(input?: {
  contentText?: string;
  imageOccurrences?: PlatformContent["imageOccurrences"];
}): PlatformContent {
  return {
    platform: "X",
    externalId: xExternalIdSchema.parse("1900000000000000000"),
    url: "https://x.com/example/status/1900000000000000000",
    contentText: input?.contentText ?? "Alpha beta gamma",
    hasVideo: false,
    imageOccurrences: input?.imageOccurrences ?? [],
    metadata: {
      authorHandle: "example",
      text: input?.contentText ?? "Alpha beta gamma",
      mediaUrls: [],
    },
  };
}

function tracked(content: PlatformContent): PageSnapshot {
  return { kind: "TRACKED_POST", adapter: STUB_ADAPTER, content };
}

function pageSkip(url: string, reason: "private_or_gated" | "unsupported_content"): PageSnapshot {
  const locator = pageLocatorFor("SUBSTACK", url);
  if (locator === null) throw new Error("expected a Substack locator");
  return {
    kind: "SKIPPED",
    platform: "SUBSTACK",
    pageUrl: url,
    reason,
    basis: { kind: "PAGE", locator },
  };
}

test("snapshots that are not page sessions have no key", () => {
  assert.equal(sessionKeyFor({ kind: "NONE" }), null);
  assert.equal(sessionKeyFor({ kind: "PENDING" }), null);
});

test("an edit to the observed content or its images starts a new session", () => {
  const base = sessionKeyFor(tracked(xContent()));
  assert.notEqual(sessionKeyFor(tracked(xContent({ contentText: "Alpha beta delta" }))), base);
  assert.notEqual(
    sessionKeyFor(
      tracked(
        xContent({
          imageOccurrences: [
            { originalIndex: 0, normalizedTextOffset: 6, sourceUrl: "https://example.com/a.png" },
          ],
        }),
      ),
    ),
    base,
  );
  assert.equal(sessionKeyFor(tracked(xContent())), base);
});

test("page-derived skips are keyed by page and reason, so another page or reason is a new session", () => {
  const alpha = sessionKeyFor(
    pageSkip("https://alpha.substack.com/p/paid-post", "private_or_gated"),
  );
  assert.equal(
    sessionKeyFor(pageSkip("https://alpha.substack.com/p/paid-post?ref=x", "private_or_gated")),
    alpha,
  );
  assert.notEqual(
    sessionKeyFor(pageSkip("https://beta.substack.com/p/paid-post", "private_or_gated")),
    alpha,
  );
  assert.notEqual(
    sessionKeyFor(pageSkip("https://alpha.substack.com/p/paid-post", "unsupported_content")),
    alpha,
  );
});

test("a content-derived skip and a tracked post never share a session key", () => {
  const content = xContent();
  const skipped: PageSnapshot = {
    kind: "SKIPPED",
    platform: "X",
    pageUrl: content.url,
    reason: "word_count",
    basis: { kind: "CONTENT", content },
  };
  assert.notEqual(sessionKeyFor(skipped), sessionKeyFor(tracked(content)));
});
