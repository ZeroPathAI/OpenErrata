import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lesswrongHtmlToNormalizedText,
  wikipediaHtmlToNormalizedText,
} from "../../src/lib/services/content-fetcher.js";

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

  assert.equal(lesswrongHtmlToNormalizedText(html), "Tea & Biscuits \u2014 \u2014");
});

test("lesswrongHtmlToNormalizedText decodes common accented named entities", () => {
  const html = "caf&eacute; and cr&egrave;me br&ucirc;l&eacute;e";

  assert.equal(lesswrongHtmlToNormalizedText(html), "café and crème brûlée");
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

test("wikipediaHtmlToNormalizedText excludes references section and citation superscripts", () => {
  const html = `
    <div class="mw-parser-output">
      <p>Lead statement.<sup class="reference">[1]</sup></p>
      <h2><span class="mw-headline">Evidence</span></h2>
      <p>Observed trend.</p>
      <h2><span class="mw-headline">References</span></h2>
      <ol class="references"><li>Should not appear.</li></ol>
    </div>
  `;

  assert.equal(wikipediaHtmlToNormalizedText(html), "Lead statement. Evidence Observed trend.");
});

test("wikipediaHtmlToNormalizedText keeps headings and figure captions", () => {
  const html = `
    <div class="mw-parser-output">
      <h2><span class="mw-headline">History</span></h2>
      <p>Important paragraph.</p>
      <figure>
        <img src="/image.jpg" />
        <figcaption>Context caption.</figcaption>
      </figure>
    </div>
  `;

  assert.equal(
    wikipediaHtmlToNormalizedText(html),
    "History Important paragraph. Context caption.",
  );
});

test("wikipediaHtmlToNormalizedText preserves non-reference superscripts", () => {
  const html = `
    <div class="mw-parser-output">
      <p>H<sup>2</sup>O and E = mc<sup>2</sup>.</p>
    </div>
  `;

  assert.equal(wikipediaHtmlToNormalizedText(html), "H2O and E = mc2.");
});

test("wikipediaHtmlToNormalizedText excludes references-class blocks outside references heading", () => {
  const html = `
    <div class="mw-parser-output">
      <p>Lead paragraph.</p>
      <ol class="references">
        <li>Reference that should be excluded.</li>
      </ol>
      <p>Closing paragraph.</p>
    </div>
  `;

  assert.equal(wikipediaHtmlToNormalizedText(html), "Lead paragraph. Closing paragraph.");
});

// ── Parsoid heading wrapper format ────────────────────────────────────────────
// Wikipedia's Parsoid renderer wraps headings in <div class="mw-heading mw-headingN">,
// which changes how section exclusion interacts with skip-level tracking.

test("wikipediaHtmlToNormalizedText excludes section under Parsoid div.mw-heading wrapper", () => {
  const html = `
    <div class="mw-parser-output">
      <p>Lead paragraph.</p>
      <div class="mw-heading mw-heading2">
        <h2 id="Notes">Notes</h2>
        <span class="mw-editsection">[edit]</span>
      </div>
      <ul><li>Some link.</li></ul>
    </div>
  `;

  assert.equal(wikipediaHtmlToNormalizedText(html), "Lead paragraph.");
});

test("wikipediaHtmlToNormalizedText resumes inclusion after excluded Parsoid section when a non-excluded section follows", () => {
  const html = `
    <div class="mw-parser-output">
      <p>Lead paragraph.</p>
      <div class="mw-heading mw-heading2">
        <h2 id="Notes">Notes</h2>
        <span class="mw-editsection">[edit]</span>
      </div>
      <ul><li>Excluded link.</li></ul>
      <div class="mw-heading mw-heading2">
        <h2 id="Legacy">Legacy</h2>
        <span class="mw-editsection">[edit]</span>
      </div>
      <p>Legacy content.</p>
      <div class="mw-heading mw-heading2">
        <h2 id="References">References</h2>
        <span class="mw-editsection">[edit]</span>
      </div>
      <ol class="references"><li>Ref.</li></ol>
    </div>
  `;

  assert.equal(wikipediaHtmlToNormalizedText(html), "Lead paragraph. Legacy Legacy content.");
});

test("wikipediaHtmlToNormalizedText handles Parsoid h3 sub-section exclusion under excluded h2", () => {
  const html = `
    <div class="mw-parser-output">
      <p>Main content.</p>
      <div class="mw-heading mw-heading2">
        <h2 id="Further_reading">Further reading</h2>
      </div>
      <ul><li>Excluded.</li></ul>
      <div class="mw-heading mw-heading3">
        <h3 id="Sub_section">Sub-section of Further reading</h3>
      </div>
      <p>Also excluded.</p>
      <div class="mw-heading mw-heading2">
        <h2 id="Notes">Notes</h2>
      </div>
      <p>Also excluded notes.</p>
    </div>
  `;

  assert.equal(wikipediaHtmlToNormalizedText(html), "Main content.");
});
