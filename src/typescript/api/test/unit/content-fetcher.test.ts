import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTENT_BLOCK_SEPARATOR_TAGS,
  WIKIPEDIA_EXCLUDED_SECTION_TITLES,
} from "@openerrata/shared";
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

// ── NON_CONTENT_TAGS exclusion (bug fix) ──────────────────────────────────────
// htmlToTextContent previously had no element filtering, so <script>, <style>,
// and <noscript> text content leaked into the LessWrong canonical text.

test("lesswrongHtmlToNormalizedText excludes script tag content", () => {
  const html = '<p>Article text.</p><script>var x = "leaked";</script><p>More text.</p>';

  const result = lesswrongHtmlToNormalizedText(html);
  assert.ok(!result.includes("leaked"), "script content must not appear in output");
  assert.equal(result, "Article text. More text.");
});

test("lesswrongHtmlToNormalizedText excludes style tag content", () => {
  const html = "<p>Article text.</p><style>.cls { color: red; }</style><p>More text.</p>";

  const result = lesswrongHtmlToNormalizedText(html);
  assert.ok(!result.includes("color"), "style content must not appear in output");
  assert.equal(result, "Article text. More text.");
});

test("lesswrongHtmlToNormalizedText excludes noscript tag content", () => {
  const html =
    '<p>Article text.</p><noscript><img src="tracking.gif" alt="tracker"></noscript><p>More text.</p>';

  const result = lesswrongHtmlToNormalizedText(html);
  assert.ok(!result.includes("tracking"), "noscript content must not appear in output");
  assert.equal(result, "Article text. More text.");
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

// ── Block separator exhaustiveness ────────────────────────────────────────────
// Every tag in CONTENT_BLOCK_SEPARATOR_TAGS must produce word-separated output
// when adjacent elements have no whitespace text node between them.  Both
// extractors (lesswrong / wikipedia) are tested because they use different
// internal traversal implementations that must stay in sync.
//
// Table-related tags (<tr>, <td>, <th>) cannot contain text as direct children
// in valid HTML — parse5 foster-parents text nodes outside the element when no
// table context exists, which defeats the block-separator check.  The map below
// provides minimal valid table structures that exercise each tag as a separator.
const TABLE_BLOCK_SEPARATOR_HTML: Record<string, string> = {
  tr: "<table><tbody><tr><td>Word1</td></tr><tr><td>Word2</td></tr></tbody></table>",
  td: "<table><tbody><tr><td>Word1</td><td>Word2</td></tr></tbody></table>",
  th: "<table><thead><tr><th>Word1</th><th>Word2</th></tr></thead></table>",
};

test("lesswrongHtmlToNormalizedText separates text across adjacent CONTENT_BLOCK_SEPARATOR_TAGS elements", () => {
  for (const tag of CONTENT_BLOCK_SEPARATOR_TAGS) {
    const html = TABLE_BLOCK_SEPARATOR_HTML[tag] ?? `<${tag}>Word1</${tag}><${tag}>Word2</${tag}>`;
    assert.equal(
      lesswrongHtmlToNormalizedText(html),
      "Word1 Word2",
      `<${tag}> should produce word-separated output`,
    );
  }
});

test("wikipediaHtmlToNormalizedText separates text across adjacent CONTENT_BLOCK_SEPARATOR_TAGS elements", () => {
  for (const tag of CONTENT_BLOCK_SEPARATOR_TAGS) {
    const inner = TABLE_BLOCK_SEPARATOR_HTML[tag] ?? `<${tag}>Word1</${tag}><${tag}>Word2</${tag}>`;
    assert.equal(
      wikipediaHtmlToNormalizedText(`<div class="mw-parser-output">${inner}</div>`),
      "Word1 Word2",
      `<${tag}> should produce word-separated output`,
    );
  }
});

// ── Excluded section titles × heading formats ─────────────────────────────────
// Every title in WIKIPEDIA_EXCLUDED_SECTION_TITLES must be excluded from output
// in both the legacy heading format (<h2><span class="mw-headline">) and the
// Parsoid heading format (<div class="mw-heading"><h2>).  A gap here means a
// section whose title is in the list can silently appear in canonical text.

// ── noscript exclusion ────────────────────────────────────────────────────────
// Wikipedia's #mw-content-text div contains a <noscript> CentralAutoLogin
// tracking pixel after .mw-parser-output closes.  getContentRoot() returns
// #mw-content-text (querySelector returns the parent before its descendants in
// document order), so the noscript is inside the extraction root.
//
// In a real browser (scripting enabled), <noscript> content is a raw text node
// containing literal HTML — e.g. `<img src="…CentralAutoLogin…">`.  If
// shouldExcludeWikipediaElement does not exclude noscript, the server includes
// that literal HTML when parse5 parses contentRoot.outerHTML (parse5 also
// defaults to scripting-enabled mode).
//
// The Assassination_of_Ali_Khamenei page ends with "See also" (not an excluded
// section), so skipSectionLevel is not set when the noscript is reached.  This
// caused canonicalization drift: the server text contained the literal <img…> HTML
// while the Wikipedia Parse API response, which the server fetches in
// production, does not include the noscript at all.

test("wikipediaHtmlToNormalizedText excludes noscript content even when last section is not an excluded title", () => {
  // Mirrors the Assassination_of_Ali_Khamenei structure: the last section is
  // "See also" (not excluded), followed by a noscript tracking pixel in
  // #mw-content-text.
  const html = `
    <div id="mw-content-text">
      <div class="mw-content-ltr mw-parser-output">
        <p>Article body text.</p>
        <div class="mw-heading mw-heading2"><h2>See also</h2></div>
        <ul><li>Related article</li></ul>
      </div>
      <noscript><img src="https://en.wikipedia.org/wiki/Special:CentralAutoLogin/start?useformat=desktop&amp;type=1x1&amp;usesul3=1" alt="" width="1" height="1" style="border: none; position: absolute;"></noscript>
      <div class="printfooter">Retrieved from "..."</div>
    </div>
  `;

  const text = wikipediaHtmlToNormalizedText(html);
  assert.ok(
    !text.includes("CentralAutoLogin"),
    "noscript tracking pixel must not appear in extracted text",
  );
  assert.ok(!text.includes("<img"), "no literal HTML tags should appear in extracted text");
  assert.ok(text.includes("Article body text."), "article body text must be included");
  assert.ok(text.includes("Related article"), "See also section content must be included");
});

test("wikipediaHtmlToNormalizedText excludes all WIKIPEDIA_EXCLUDED_SECTION_TITLES in legacy heading format", () => {
  for (const title of WIKIPEDIA_EXCLUDED_SECTION_TITLES) {
    const displayTitle = title.charAt(0).toUpperCase() + title.slice(1);
    const html = `
      <div class="mw-parser-output">
        <p>Lead paragraph.</p>
        <h2><span class="mw-headline">${displayTitle}</span></h2>
        <p>Excluded section text.</p>
      </div>
    `;
    assert.ok(
      !wikipediaHtmlToNormalizedText(html).includes("Excluded section text."),
      `"${title}" section should be excluded (legacy heading format)`,
    );
  }
});

test("wikipediaHtmlToNormalizedText excludes all WIKIPEDIA_EXCLUDED_SECTION_TITLES in Parsoid heading format", () => {
  for (const title of WIKIPEDIA_EXCLUDED_SECTION_TITLES) {
    const displayTitle = title.charAt(0).toUpperCase() + title.slice(1);
    const html = `
      <div class="mw-parser-output">
        <p>Lead paragraph.</p>
        <div class="mw-heading mw-heading2">
          <h2>${displayTitle}</h2>
          <span class="mw-editsection">[edit]</span>
        </div>
        <p>Excluded section text.</p>
      </div>
    `;
    assert.ok(
      !wikipediaHtmlToNormalizedText(html).includes("Excluded section text."),
      `"${title}" section should be excluded (Parsoid heading format)`,
    );
  }
});
