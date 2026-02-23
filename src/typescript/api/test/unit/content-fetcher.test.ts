import assert from "node:assert/strict";
import { test } from "node:test";
import { lesswrongHtmlToNormalizedText } from "../../src/lib/services/content-fetcher.js";

test("lesswrongHtmlToNormalizedText strips tags with quoted > attributes", () => {
  const html = '<p data-note="x > y">Alpha</p>\n<p>Beta</p>';

  assert.equal(lesswrongHtmlToNormalizedText(html), "Alpha Beta");
});

test("lesswrongHtmlToNormalizedText preserves malformed literal less-than text", () => {
  const html = "<p>1 < 2</p>";

  assert.equal(lesswrongHtmlToNormalizedText(html), "1 < 2");
});

test("lesswrongHtmlToNormalizedText removes HTML comments", () => {
  const html = "<p>Hello</p> <!-- hidden --> <p>world</p>";

  assert.equal(lesswrongHtmlToNormalizedText(html), "Hello world");
});

test("lesswrongHtmlToNormalizedText decodes supported named and numeric entities", () => {
  const html = "Tea&nbsp;&amp;&nbsp;Biscuits &#x2014; &#8212;";

  assert.equal(
    lesswrongHtmlToNormalizedText(html),
    "Tea & Biscuits \u2014 \u2014",
  );
});

test("lesswrongHtmlToNormalizedText decodes common accented named entities", () => {
  const html = "caf&eacute; and cr&egrave;me br&ucirc;l&eacute;e";

  assert.equal(
    lesswrongHtmlToNormalizedText(html),
    "café and crème brûlée",
  );
});

test("lesswrongHtmlToNormalizedText decodes uppercase hex entities", () => {
  const html = "Letter: &#X41;";

  assert.equal(lesswrongHtmlToNormalizedText(html), "Letter: A");
});

test("lesswrongHtmlToNormalizedText decodes full HTML5 named entities", () => {
  const html = "Symbol: &CounterClockwiseContourIntegral;";

  assert.equal(lesswrongHtmlToNormalizedText(html), "Symbol: ∳");
});

test("lesswrongHtmlToNormalizedText follows HTML parsing for invalid code points", () => {
  const html = "Hello &#x110000; world";

  assert.equal(lesswrongHtmlToNormalizedText(html), "Hello \uFFFD world");
});

test("lesswrongHtmlToNormalizedText preserves escaped literal tags as text", () => {
  const html = "&lt;em&gt;not markup&lt;/em&gt;";

  assert.equal(lesswrongHtmlToNormalizedText(html), "<em>not markup</em>");
});
