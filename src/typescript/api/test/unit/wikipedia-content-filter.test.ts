import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFragment } from "parse5";
import {
  preFilterWikipediaHtml,
  createWikipediaNodeFilter,
} from "../../src/lib/services/wikipedia-content-filter.js";

// ── preFilterWikipediaHtml ───────────────────────────────────────────────────

test("preFilterWikipediaHtml removes legacy-format excluded sections", () => {
  const html = [
    "<p>Article body.</p>",
    '<h2><span class="mw-headline">References</span></h2>',
    '<ol class="references"><li>Ref 1</li></ol>',
  ].join("");

  const result = preFilterWikipediaHtml(html);
  assert.ok(result.includes("Article body."));
  assert.ok(!result.includes("Ref 1"));
  assert.ok(!result.includes("References"));
});

test("preFilterWikipediaHtml removes Parsoid-format excluded sections", () => {
  const html = [
    "<p>Keep this.</p>",
    '<div class="mw-heading mw-heading2"><h2>External links</h2></div>',
    '<ul><li><a href="http://example.com">Example</a></li></ul>',
  ].join("");

  const result = preFilterWikipediaHtml(html);
  assert.ok(result.includes("Keep this."));
  assert.ok(!result.includes("Example"));
  assert.ok(!result.includes("External links"));
});

test("preFilterWikipediaHtml preserves non-excluded sections", () => {
  const html = [
    '<h2><span class="mw-headline">History</span></h2>',
    "<p>Important history content.</p>",
  ].join("");

  const result = preFilterWikipediaHtml(html);
  assert.ok(result.includes("Important history content."));
  assert.ok(result.includes("History"));
});

test("preFilterWikipediaHtml preserves See also (not excluded)", () => {
  const html = [
    '<h2><span class="mw-headline">See also</span></h2>',
    "<ul><li>Related article</li></ul>",
  ].join("");

  const result = preFilterWikipediaHtml(html);
  assert.ok(result.includes("Related article"));
});

test("preFilterWikipediaHtml removes excluded-class elements even outside excluded sections", () => {
  const html = '<p>Text <sup class="reference">[1]</sup> continues.</p>';
  const result = preFilterWikipediaHtml(html);
  assert.ok(result.includes("Text"));
  assert.ok(result.includes("continues."));
  assert.ok(!result.includes("[1]"));
});

test("preFilterWikipediaHtml removes script, style, and noscript elements", () => {
  const html = [
    "<p>Visible.</p>",
    '<script>alert("xss")</script>',
    "<style>.cls{color:red}</style>",
    '<noscript><img src="tracker.gif"></noscript>',
  ].join("");

  const result = preFilterWikipediaHtml(html);
  assert.ok(result.includes("Visible."));
  assert.ok(!result.includes("alert"));
  assert.ok(!result.includes("color:red"));
  assert.ok(!result.includes("tracker.gif"));
});

test("preFilterWikipediaHtml handles empty input", () => {
  assert.equal(preFilterWikipediaHtml(""), "");
});

test("preFilterWikipediaHtml stops section exclusion at next same-level heading", () => {
  const html = [
    '<h2><span class="mw-headline">References</span></h2>',
    "<ol><li>Should be removed</li></ol>",
    '<h2><span class="mw-headline">History</span></h2>',
    "<p>Should be kept.</p>",
  ].join("");

  const result = preFilterWikipediaHtml(html);
  assert.ok(!result.includes("Should be removed"));
  assert.ok(result.includes("Should be kept."));
});

test("preFilterWikipediaHtml continues section exclusion past deeper headings", () => {
  const html = [
    '<h2><span class="mw-headline">References</span></h2>',
    '<h3><span class="mw-headline">Footnotes</span></h3>',
    "<p>Footnote content that should be removed.</p>",
    '<h2><span class="mw-headline">History</span></h2>',
    "<p>Kept.</p>",
  ].join("");

  const result = preFilterWikipediaHtml(html);
  assert.ok(!result.includes("Footnote content"));
  assert.ok(result.includes("Kept."));
});

// ── createWikipediaNodeFilter (stateful section tracking) ────────────────────

test("createWikipediaNodeFilter includes text nodes outside excluded sections", () => {
  // The filter starts in "include" state; a text node before any excluded
  // heading should be included.
  const filter = createWikipediaNodeFilter();

  // parseFragment produces a parse5 tree; extract a text node from it.
  const fragment = parseFragment("<p>hello</p>");
  const pNode = fragment.childNodes[0];
  assert.ok(pNode !== undefined);
  assert.equal(filter(pNode), "include");
});
