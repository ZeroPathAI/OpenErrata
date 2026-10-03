import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionPageStatusSchema, type ExtensionPageStatus } from "@openerrata/shared";
import { isPossiblySupportedPage, statusDescribesTabPage } from "../../src/popup/status-identity";

function skipped(platform: ExtensionPageStatus["platform"], pageUrl: string): ExtensionPageStatus {
  return extensionPageStatusSchema.parse({
    kind: "SKIPPED",
    tabSessionId: "00000000-0000-4000-8000-000000000001",
    platform,
    pageUrl,
    reason: "private_or_gated",
  });
}

test("isPossiblySupportedPage accepts platform post pages and any /p/ page", () => {
  assert.equal(isPossiblySupportedPage("https://astralcodexten.com/p/open-thread-365"), true);
  assert.equal(isPossiblySupportedPage("https://x.com/example/status/123"), true);
  assert.equal(isPossiblySupportedPage("https://example.com/about"), false);
});

test("a cached status describes the tab only while the tab shows the same post", () => {
  const xStatus = skipped("X", "https://x.com/example/status/123");
  assert.equal(statusDescribesTabPage(xStatus, "https://x.com/other/status/123?s=20"), true);
  assert.equal(statusDescribesTabPage(xStatus, "https://x.com/example/status/456"), false);

  const wikipedia = skipped("WIKIPEDIA", "https://en.wikipedia.org/wiki/Climate_change");
  assert.equal(
    statusDescribesTabPage(wikipedia, "https://en.wikipedia.org/wiki/Climate_change#History"),
    true,
  );
  assert.equal(
    statusDescribesTabPage(wikipedia, "https://en.wikipedia.org/wiki/Global_warming"),
    false,
  );

  // Custom-domain Substack: same origin and post path.
  const substack = skipped("SUBSTACK", "https://astralcodexten.com/p/open-thread-365");
  assert.equal(
    statusDescribesTabPage(substack, "https://astralcodexten.com/p/open-thread-365"),
    true,
  );
  assert.equal(statusDescribesTabPage(substack, "https://astralcodexten.com/about"), false);
  assert.equal(
    statusDescribesTabPage(substack, "https://astralcodexten.com/p/different-post"),
    false,
  );
  assert.equal(
    statusDescribesTabPage(substack, "https://other.substack.com/p/open-thread-365"),
    false,
  );
});
