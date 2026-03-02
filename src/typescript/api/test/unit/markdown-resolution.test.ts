import assert from "node:assert/strict";
import { test } from "node:test";
import type { Platform } from "@openerrata/shared";
import { MARKDOWN_RENDERER_VERSION } from "../../src/lib/services/html-to-markdown.js";
import { resolveMarkdownForInvestigation } from "../../src/lib/services/markdown-resolution.js";

const HTML_PLATFORMS: Platform[] = ["LESSWRONG", "SUBSTACK", "WIKIPEDIA"];

function sampleHtml(platform: Platform): string {
  return `<h1>${platform} title</h1><p>Body with an <img src="https://example.com/image.png" /></p>`;
}

test("resolveMarkdownForInvestigation trust source is monotonic with serverVerifiedAt latch", () => {
  for (const platform of HTML_PLATFORMS) {
    const html = sampleHtml(platform);

    const clientFallback = resolveMarkdownForInvestigation({
      platform,
      snapshots: { serverVerifiedAt: null, serverHtml: null, clientHtml: html },
    });
    assert.equal(clientFallback.source, "CLIENT_HTML");

    const serverVerified = resolveMarkdownForInvestigation({
      platform,
      snapshots: {
        serverVerifiedAt: new Date("2026-02-20T12:00:00.000Z"),
        serverHtml: html,
        clientHtml: html,
      },
    });
    assert.equal(serverVerified.source, "SERVER_HTML");

    // Trust label can change from CLIENT_HTML -> SERVER_HTML, but the rendered
    // markdown payload should stay stable for identical HTML input.
    assert.equal(serverVerified.markdown, clientFallback.markdown);
    assert.deepEqual(serverVerified.imagePlaceholders, clientFallback.imagePlaceholders);
    assert.equal(serverVerified.rendererVersion, MARKDOWN_RENDERER_VERSION);
    assert.equal(clientFallback.rendererVersion, MARKDOWN_RENDERER_VERSION);
  }
});

test("resolveMarkdownForInvestigation returns NONE for missing html regardless of latch", () => {
  const platforms: Platform[] = ["LESSWRONG", "SUBSTACK", "WIKIPEDIA", "X"];

  for (const platform of platforms) {
    assert.deepEqual(
      resolveMarkdownForInvestigation({
        platform,
        snapshots: { serverVerifiedAt: null, serverHtml: null, clientHtml: null },
      }),
      { source: "NONE" },
    );
  }
});
