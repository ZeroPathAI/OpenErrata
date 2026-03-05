import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionPageStatusSchema, type PlatformContent } from "@openerrata/shared";
import type { PlatformAdapter } from "../../src/content/adapters/index.js";
import { toViewPostInput } from "../../src/lib/view-post-input.js";
import {
  createInitialPageSessionState,
  createSkippedSessionState,
  createTrackedPostSessionState,
  isActiveTrackedSession,
  isCurrentSessionPostStatus,
  shouldRefreshSkippedSessionOnMutation,
  type TrackedPostSnapshot,
} from "../../src/content/session-state.js";

function makeFakeAdapter(): PlatformAdapter {
  return {
    platformKey: "LESSWRONG",
    matches: () => true,
    extract: () => ({
      kind: "ready",
      content: makeTrackedContent(),
    }),
    getContentRoot: () => null,
  } as unknown as PlatformAdapter;
}

function makeTrackedContent(): PlatformContent {
  return {
    platform: "LESSWRONG",
    externalId: "post-1",
    url: "https://www.lesswrong.com/posts/post-1/example",
    contentText: "hello world",
    mediaState: "text_only",
    imageUrls: [],
    metadata: {
      slug: "example-post",
      htmlContent: "<p>hello world</p>",
      tags: ["tag-1"],
    },
  };
}

function makeTrackedSnapshot(): TrackedPostSnapshot {
  const content = makeTrackedContent();
  return {
    kind: "TRACKED_POST",
    sessionKey: "session:1",
    platform: "LESSWRONG",
    externalId: "post-1",
    adapter: makeFakeAdapter(),
    content,
    request: toViewPostInput(content),
  };
}

test("createInitialPageSessionState returns idle state", () => {
  assert.deepEqual(createInitialPageSessionState(), {
    kind: "IDLE",
    tabSessionId: 0,
    sessionKey: null,
  });
});

test("createSkippedSessionState projects skipped snapshot into session state", () => {
  const state = createSkippedSessionState(7, {
    kind: "SKIPPED",
    sessionKey: "skip:1",
    platform: "LESSWRONG",
    externalId: "post-1",
    pageUrl: "https://www.lesswrong.com/posts/post-1/example",
    reason: "no_text",
  });

  assert.deepEqual(state, {
    kind: "SKIPPED",
    tabSessionId: 7,
    sessionKey: "skip:1",
    platform: "LESSWRONG",
    externalId: "post-1",
    pageUrl: "https://www.lesswrong.com/posts/post-1/example",
    reason: "no_text",
  });
});

test("isActiveTrackedSession matches by tab session + post identity", () => {
  const trackedState = createTrackedPostSessionState(3, makeTrackedSnapshot(), "hello world");

  assert.equal(isActiveTrackedSession(trackedState, trackedState), true);

  const other = createTrackedPostSessionState(4, makeTrackedSnapshot(), "hello world");
  assert.equal(isActiveTrackedSession(trackedState, other), false);
});

test("isCurrentSessionPostStatus only matches tracked post identity", () => {
  const trackedState = createTrackedPostSessionState(3, makeTrackedSnapshot(), "hello world");

  assert.equal(
    isCurrentSessionPostStatus(
      trackedState,
      extensionPageStatusSchema.parse({
        kind: "POST",
        tabSessionId: 3,
        platform: "LESSWRONG",
        externalId: "post-1",
        pageUrl: "https://www.lesswrong.com/posts/post-1/example",
        investigationState: "NOT_INVESTIGATED",
        priorInvestigationResult: null,
      }),
    ),
    true,
  );

  assert.equal(
    isCurrentSessionPostStatus(
      trackedState,
      extensionPageStatusSchema.parse({
        kind: "POST",
        tabSessionId: 99,
        platform: "LESSWRONG",
        externalId: "post-1",
        pageUrl: "https://www.lesswrong.com/posts/post-1/example",
        investigationState: "NOT_INVESTIGATED",
        priorInvestigationResult: null,
      }),
    ),
    false,
  );
});

test("shouldRefreshSkippedSessionOnMutation only refreshes mutable skipped reasons", () => {
  assert.equal(shouldRefreshSkippedSessionOnMutation("no_text", true), true);
  assert.equal(shouldRefreshSkippedSessionOnMutation("unsupported_content", true), true);
  assert.equal(shouldRefreshSkippedSessionOnMutation("private_or_gated", true), true);
  assert.equal(shouldRefreshSkippedSessionOnMutation("has_video", true), false);
  assert.equal(shouldRefreshSkippedSessionOnMutation("word_count", true), false);
  assert.equal(shouldRefreshSkippedSessionOnMutation("no_text", false), false);
});
