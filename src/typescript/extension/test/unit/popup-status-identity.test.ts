import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionPageStatus } from "@openerrata/shared";
import type { SupportedPageIdentity } from "../../src/lib/post-identity";
import {
  isSubstackPostPathUrl,
  statusMatchesIdentity,
} from "../../src/popup/status-identity";

function createPostStatus(
  platform: ExtensionPageStatus["platform"],
  externalId: string,
  pageUrl: string,
): ExtensionPageStatus {
  return {
    kind: "POST",
    tabSessionId: 1,
    platform,
    externalId,
    pageUrl,
    investigationState: "NOT_INVESTIGATED",
    claims: null,
  };
}

test("isSubstackPostPathUrl detects /p/ paths", () => {
  assert.equal(
    isSubstackPostPathUrl("https://astralcodexten.com/p/open-thread-365"),
    true,
  );
  assert.equal(isSubstackPostPathUrl("https://x.com/example/status/123"), false);
});

test("statusMatchesIdentity keeps strict matching for non-Substack", () => {
  const status = createPostStatus("X", "123", "https://x.com/example/status/123");
  const identity: SupportedPageIdentity = {
    platform: "X",
    externalId: "456",
  };

  assert.equal(
    statusMatchesIdentity(status, identity, "https://x.com/example/status/456"),
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
    statusMatchesIdentity(
      status,
      null,
      "https://astralcodexten.com/p/open-thread-365",
    ),
    true,
  );
  assert.equal(
    statusMatchesIdentity(status, null, "https://astralcodexten.com/about"),
    false,
  );
  assert.equal(
    statusMatchesIdentity(
      status,
      null,
      "https://astralcodexten.com/p/different-post",
    ),
    false,
  );
});
