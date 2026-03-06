import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderClaimReasoningHtml } from "../../src/lib/claim-markdown.js";

describe("renderClaimReasoningHtml", () => {
  it("renders headings, emphasis, and safe links as HTML", () => {
    const html = renderClaimReasoningHtml(
      "### Contradictory evidence\n\n**Bold** text and [source](https://example.com).",
    );

    assert.match(html, /<h3>Contradictory evidence<\/h3>/);
    assert.match(html, /<strong>Bold<\/strong>/);
    assert.match(html, /href="https:\/\/example\.com"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
  });

  it("escapes raw HTML instead of rendering it", () => {
    const html = renderClaimReasoningHtml('<script>alert("xss")</script>');

    assert.equal(html.includes("<script>"), false);
    assert.equal(html.includes("&lt;script&gt;alert"), true);
  });
});
