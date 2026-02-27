import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionPostStatusSchema, type ExtensionPageStatus } from "@openerrata/shared";
import type { SupportedPageIdentity } from "../../src/lib/post-identity";
import { isSubstackPostPathUrl, statusMatchesIdentity } from "../../src/popup/status-identity";

function createPostStatus(
  platform: ExtensionPageStatus["platform"],
  externalId: string,
  pageUrl: string,
): ExtensionPageStatus {
  return extensionPostStatusSchema.parse({
    kind: "POST",
    tabSessionId: 1,
    platform,
    externalId,
    pageUrl,
    investigationState: "NOT_INVESTIGATED",
    claims: null,
    priorInvestigationResult: null,
  });
}

test("isSubstackPostPathUrl detects /p/ paths", () => {
  assert.equal(isSubstackPostPathUrl("https://astralcodexten.com/p/open-thread-365"), true);
  assert.equal(isSubstackPostPathUrl("https://x.com/example/status/123"), false);
});

test("statusMatchesIdentity keeps strict matching for non-Substack", () => {
  const status = createPostStatus("X", "123", "https://x.com/example/status/123");
  const identity: SupportedPageIdentity = {
    platform: "X",
    externalId: "456",
  };

  assert.equal(statusMatchesIdentity(status, identity, "https://x.com/example/status/456"), false);
});

test("statusMatchesIdentity accepts Wikipedia status when URL title matches despite canonical pageId externalId", () => {
  const status = createPostStatus(
    "WIKIPEDIA",
    "en:12345",
    "https://en.wikipedia.org/wiki/Climate_change",
  );
  const identity: SupportedPageIdentity = {
    platform: "WIKIPEDIA",
    externalId: "en:Climate_change",
  };

  assert.equal(
    statusMatchesIdentity(status, identity, "https://en.wikipedia.org/wiki/Climate_change"),
    true,
  );
});

test("statusMatchesIdentity rejects Wikipedia status when tab URL points to different article title", () => {
  const status = createPostStatus(
    "WIKIPEDIA",
    "en:12345",
    "https://en.wikipedia.org/wiki/Climate_change",
  );
  const identity: SupportedPageIdentity = {
    platform: "WIKIPEDIA",
    externalId: "en:Global_warming",
  };

  assert.equal(
    statusMatchesIdentity(status, identity, "https://en.wikipedia.org/wiki/Global_warming"),
    false,
  );
});

test("statusMatchesIdentity allows Substack slug-vs-numeric identity mismatch", () => {
  const status = createPostStatus(
    "SUBSTACK",
    "987654321",
    "https://astralcodexten.substack.com/p/open-thread-365",
  );
  const identity: SupportedPageIdentity = {
    platform: "SUBSTACK",
    externalId: "open-thread-365",
  };

  assert.equal(
    statusMatchesIdentity(
      status,
      identity,
      "https://astralcodexten.substack.com/p/open-thread-365",
    ),
    true,
  );
});

test("statusMatchesIdentity allows custom-domain Substack when URL is /p/*", () => {
  const status = createPostStatus(
    "SUBSTACK",
    "987654321",
    "https://astralcodexten.com/p/open-thread-365",
  );

  assert.equal(
    statusMatchesIdentity(status, null, "https://astralcodexten.com/p/open-thread-365"),
    true,
  );
  assert.equal(statusMatchesIdentity(status, null, "https://astralcodexten.com/about"), false);
  assert.equal(
    statusMatchesIdentity(status, null, "https://astralcodexten.com/p/different-post"),
    false,
  );
});
