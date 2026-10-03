import assert from "node:assert/strict";
import { test } from "node:test";
import { lesswrongExternalIdSchema, type PlatformContent } from "@openerrata/shared";
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
import {
  isStatusOfSession,
  sessionKeyOfState,
  shouldRefreshSkippedSessionOnMutation,
  type PageSessionState,
} from "../../src/content/session-state.js";
import { notInvestigatedStatus, sessionId } from "../helpers/statuses.js";

const content: PlatformContent = {
  platform: "LESSWRONG",
  externalId: lesswrongExternalIdSchema.parse("post1"),
  url: "https://www.lesswrong.com/posts/post1/example",
  contentText: "hello world",
  hasVideo: false,
  imageOccurrences: [],
  metadata: { slug: "example", htmlContent: "<p>hello world</p>", tags: [] },
};

const tracked: PageSessionState = {
  kind: "TRACKED_POST",
  tabSessionId: sessionId(1),
  sessionKey: "tracked",
  adapter: STUB_ADAPTER,
  content,
};

test("only tracked and skipped sessions have a session key", () => {
  assert.equal(sessionKeyOfState({ kind: "IDLE" }), null);
  assert.equal(sessionKeyOfState(tracked), "tracked");
  assert.equal(
    sessionKeyOfState({
      kind: "SKIPPED",
      tabSessionId: sessionId(2),
      sessionKey: "skipped",
      reason: "has_video",
    }),
    "skipped",
  );
});

test("a status belongs to the tracked session it was cached for", () => {
  assert.equal(isStatusOfSession(tracked, notInvestigatedStatus(sessionId(1))), true);
  assert.equal(isStatusOfSession(tracked, notInvestigatedStatus(sessionId(2))), false);
  assert.equal(isStatusOfSession({ kind: "IDLE" }, notInvestigatedStatus(sessionId(1))), false);
});

test("only page-derived skips are re-evaluated on DOM changes", () => {
  assert.equal(shouldRefreshSkippedSessionOnMutation("private_or_gated"), true);
  assert.equal(shouldRefreshSkippedSessionOnMutation("unsupported_content"), true);
  assert.equal(shouldRefreshSkippedSessionOnMutation("no_text"), true);
  assert.equal(shouldRefreshSkippedSessionOnMutation("has_video"), false);
  assert.equal(shouldRefreshSkippedSessionOnMutation("word_count"), false);
});
