import assert from "node:assert/strict";
import { test } from "node:test";
import { WIKIPEDIA_EXCLUDED_SECTION_TITLES } from "@openerrata/shared";
import {
  lesswrongHtmlToContentMarkdown,
  wikipediaHtmlToContentMarkdown,
  substackHtmlToContentMarkdown,
} from "../../src/lib/services/html-to-markdown.js";

// ── Basic structural elements ────────────────────────────────────────────

test("converts headings to markdown heading syntax", () => {
  const html = "<h1>Title</h1><h2>Subtitle</h2><h3>Sub-subtitle</h3>";
  const md = lesswrongHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("# Title"));
  assert.ok(md.includes("## Subtitle"));
  assert.ok(md.includes("### Sub-subtitle"));
});

test("converts paragraphs to double-newline-separated blocks", () => {
  const html = "<p>First paragraph.</p><p>Second paragraph.</p>";
  const md = lesswrongHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("First paragraph."));
  assert.ok(md.includes("Second paragraph."));
  // Should have separation between paragraphs.
  const firstIdx = md.indexOf("First paragraph.");
  const secondIdx = md.indexOf("Second paragraph.");
  assert.ok(secondIdx > firstIdx);
});

test("converts unordered lists to dash-prefixed items", () => {
  const html = "<ul><li>Item one</li><li>Item two</li><li>Item three</li></ul>";
  const md = lesswrongHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("-   Item one"));
  assert.ok(md.includes("-   Item two"));
  assert.ok(md.includes("-   Item three"));
});

test("converts ordered lists to numbered items", () => {
  const html = "<ol><li>First</li><li>Second</li><li>Third</li></ol>";
  const md = lesswrongHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("1.  First"), `Expected "1.  First" in: ${md}`);
  assert.ok(md.includes("2.  Second"), `Expected "2.  Second" in: ${md}`);
  assert.ok(md.includes("3.  Third"), `Expected "3.  Third" in: ${md}`);
});

test("handles nested lists with indentation", () => {
  const html =
    "<ul><li>Outer<ul><li>Inner one</li><li>Inner two</li></ul></li><li>Another outer</li></ul>";
  const md = lesswrongHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("-   Outer"), `Expected "-   Outer" in: ${md}`);
  assert.ok(md.includes("-   Inner one"), `Expected nested "-   Inner one" in: ${md}`);
  assert.ok(md.includes("-   Inner two"), `Expected nested "-   Inner two" in: ${md}`);
  assert.ok(md.includes("-   Another outer"), `Expected "-   Another outer" in: ${md}`);
});

test("converts blockquotes to > prefixed text", () => {
  const html = "<blockquote><p>A wise quote.</p></blockquote>";
  const md = lesswrongHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("> A wise quote."), `Expected "> A wise quote." in: ${md}`);
});

// ── Inline formatting ────────────────────────────────────────────────────

test("renders bold tags as plain text (no ** markers)", () => {
  const html = "<p>This is <strong>important</strong> text.</p>";
  const md = lesswrongHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("important"));
  assert.ok(!md.includes("**important**"));
});

test("renders <b> tags as plain text (no ** markers)", () => {
  const html = "<p>Also <b>bold</b> text.</p>";
  const md = lesswrongHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("bold"));
  assert.ok(!md.includes("**bold**"));
});

test("renders italic tags as plain text (no * markers)", () => {
  const html = "<p>This is <em>emphasized</em> text.</p>";
  const md = lesswrongHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("emphasized"));
  assert.ok(!md.includes("*emphasized*"));
});

test("renders <i> tags as plain text (no * markers)", () => {
  const html = "<p>Also <i>italic</i> text.</p>";
  const md = lesswrongHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("italic"));
  assert.ok(!md.includes("*italic*"));
});

test("converts links to markdown link syntax", () => {
  const html = '<p>Visit <a href="https://example.com">Example</a> for more.</p>';
  const md = lesswrongHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("[Example](https://example.com)"));
});

test("preserves superscript text inline", () => {
  const html = "<p>Footnote<sup>1</sup> here.</p>";
  const md = lesswrongHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("Footnote1 here."), `Expected inline superscript text in: ${md}`);
});

// ── Exclusions ───────────────────────────────────────────────────────────

test("excludes NON_CONTENT_TAGS (script, style, noscript)", () => {
  const html =
    '<p>Article text.</p><script>var x = "leaked";</script><style>.cls { color: red; }</style><noscript>tracking</noscript><p>More text.</p>';
  const md = lesswrongHtmlToContentMarkdown(html).markdown;
  assert.ok(!md.includes("leaked"));
  assert.ok(!md.includes("color"));
  assert.ok(!md.includes("tracking"));
  assert.ok(md.includes("Article text."));
  assert.ok(md.includes("More text."));
});

test("replaces img elements with [IMAGE:N] placeholders", () => {
  const { markdown, imagePlaceholders } = lesswrongHtmlToContentMarkdown(
    '<p>Before image.</p><img src="test.jpg" alt="test"/><p>After image.</p>',
  );
  assert.ok(!markdown.includes("test.jpg"), "src URL should not appear in markdown");
  assert.ok(markdown.includes("[IMAGE:0]"), "placeholder should appear in markdown");
  assert.ok(markdown.includes("Before image."));
  assert.ok(markdown.includes("After image."));
  assert.equal(imagePlaceholders.length, 1);
  assert.equal(imagePlaceholders[0]?.sourceUrl, "test.jpg");
});

test("strips anchor wrapper when link contains only an image", () => {
  // Substack (and other platforms) wrap images in <a href="..."><img/></a>.
  // The anchor URL is redundant because the image URL is already captured in
  // imagePlaceholders, so the link markup should be removed and only the
  // [IMAGE:N] placeholder should remain.
  const html =
    '<p>Caption text.</p><a href="https://cdn.example.com/big.jpg"><img src="https://cdn.example.com/thumb.jpg"/></a><p>After.</p>';
  const { markdown, imagePlaceholders } = substackHtmlToContentMarkdown(html);
  assert.ok(markdown.includes("[IMAGE:0]"), "placeholder should be present");
  assert.ok(
    !markdown.includes("](https://cdn.example.com/big.jpg)"),
    "anchor href should be stripped",
  );
  assert.ok(
    !markdown.includes("[ [IMAGE:0] ]"),
    "placeholder should not be wrapped in link syntax",
  );
  assert.equal(imagePlaceholders.length, 1);
  assert.equal(imagePlaceholders[0]?.sourceUrl, "https://cdn.example.com/thumb.jpg");
});

test("strips anchor wrapper for image-in-div structure (Substack CDN pattern)", () => {
  // Substack images often appear as <a href="..."><div><img src="..."/></div></a>
  // which is the structure causing "[ \n\n [IMAGE:0] \n\n](url)" in the output.
  const html = `
    <p>Here is the chart:</p>
    <a href="https://substackcdn.com/big.png">
      <div><img src="https://substackcdn.com/thumb.png"/></div>
    </a>
    <p>As you can see above.</p>
  `;
  const { markdown } = substackHtmlToContentMarkdown(html);
  assert.ok(markdown.includes("[IMAGE:0]"));
  assert.ok(!markdown.includes("](https://substackcdn.com/big.png)"));
  // No stray newlines inside the placeholder from the inner div
  assert.ok(
    !/\[\n[^\]]*\[IMAGE:0\]/.exec(markdown),
    "no newlines before placeholder inside link brackets",
  );
  assert.ok(markdown.includes("Here is the chart:"));
  assert.ok(markdown.includes("As you can see above."));
});

test("preserves anchor when link contains text alongside an image", () => {
  // An anchor with both text and an image should keep the link markup.
  const html = '<p><a href="https://example.com">See chart <img src="chart.png"/></a></p>';
  const { markdown } = lesswrongHtmlToContentMarkdown(html);
  assert.ok(
    markdown.includes("[See chart  [IMAGE:0]  ](https://example.com)") ||
      markdown.includes("https://example.com"),
    "link should be preserved when it has text content",
  );
});

// ── Entity decoding ──────────────────────────────────────────────────────

test("decodes HTML entities", () => {
  const html = "<p>Tea&nbsp;&amp;&nbsp;Biscuits</p>";
  const md = lesswrongHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("Tea"));
  assert.ok(md.includes("&"));
  assert.ok(md.includes("Biscuits"));
});

// ── The motivating case: bullet list not run-on ──────────────────────────

test("bullet list items are separate lines, not run-on text", () => {
  const html = `
    <p>The president could respond by:</p>
    <ul>
      <li>canceling the contract</li>
      <li>using the Defense Production Act</li>
      <li>issuing an executive order</li>
    </ul>
  `;
  const md = substackHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("-   canceling the contract"));
  assert.ok(md.includes("-   using the Defense Production Act"));
  assert.ok(md.includes("-   issuing an executive order"));
  // Crucially, these should NOT be joined together.
  assert.ok(
    !md.includes("canceling the contract using the Defense Production Act"),
    "list items must not be joined into run-on text",
  );
});

// ── Wikipedia section exclusion ──────────────────────────────────────────
// Every title in WIKIPEDIA_EXCLUDED_SECTION_TITLES must be excluded from
// markdown output in both the legacy and Parsoid heading formats, mirroring
// the exhaustiveness requirement in content-fetcher.test.ts for normalized text.

test("wikipediaHtmlToContentMarkdown excludes all WIKIPEDIA_EXCLUDED_SECTION_TITLES in legacy heading format", () => {
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
      !wikipediaHtmlToContentMarkdown(html).markdown.includes("Excluded section text."),
      `"${title}" section should be excluded (legacy heading format)`,
    );
  }
});

test("wikipediaHtmlToContentMarkdown excludes all WIKIPEDIA_EXCLUDED_SECTION_TITLES in Parsoid heading format", () => {
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
      !wikipediaHtmlToContentMarkdown(html).markdown.includes("Excluded section text."),
      `"${title}" section should be excluded (Parsoid heading format)`,
    );
  }
});

test("wikipedia markdown excludes citation superscripts", () => {
  const html = `
    <div class="mw-parser-output">
      <p>A fact.<sup class="reference">[1]</sup></p>
    </div>
  `;
  const md = wikipediaHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("A fact."));
  assert.ok(!md.includes("[1]"));
});

// ── Platform wrappers ────────────────────────────────────────────────────

test("lesswrongHtmlToContentMarkdown handles complex post structure", () => {
  const html = `
    <h1>Post Title</h1>
    <p>First paragraph with <strong>bold</strong> and <em>italic</em>.</p>
    <h2>Section One</h2>
    <p>Content here.</p>
    <ul>
      <li>Point A</li>
      <li>Point B</li>
    </ul>
    <blockquote><p>A quote from someone.</p></blockquote>
  `;
  const md = lesswrongHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("# Post Title"));
  assert.ok(md.includes("bold") && !md.includes("**bold**"));
  assert.ok(md.includes("italic") && !md.includes("*italic*"));
  assert.ok(md.includes("## Section One"));
  assert.ok(md.includes("-   Point A"));
  assert.ok(md.includes("-   Point B"));
  assert.ok(md.includes("A quote from someone."));
});

test("substackHtmlToContentMarkdown renders same as lesswrong for shared elements", () => {
  const html = "<h2>Title</h2><p>Paragraph one.</p><p>Paragraph two.</p>";
  const md = substackHtmlToContentMarkdown(html).markdown;
  assert.ok(md.includes("## Title"));
  assert.ok(md.includes("Paragraph one."));
  assert.ok(md.includes("Paragraph two."));
});
