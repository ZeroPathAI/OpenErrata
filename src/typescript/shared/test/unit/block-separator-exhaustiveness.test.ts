import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTENT_BLOCK_SEPARATOR_TAGS } from "../../src/normalize.js";

// ── Block separator tag exhaustiveness ──────────────────────────────────
// Every HTML spec block-level element must be either in
// CONTENT_BLOCK_SEPARATOR_TAGS or in the explicit exclusion list below with
// a documented rationale. This is a "living documentation" test — when new
// block elements become relevant, the test forces a conscious decision
// about inclusion or exclusion.

/**
 * HTML spec block-level elements. This list covers the elements defined as
 * block-level in the HTML Living Standard that can appear in article content.
 * https://developer.mozilla.org/en-US/docs/Glossary/Block-level_content
 */
const HTML_BLOCK_LEVEL_ELEMENTS = [
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "search",
  "section",
  "summary",
  "table",
  "ul",
  // Table sub-elements that act as block separators:
  "tr",
  "td",
  "th",
  "thead",
  "tbody",
  "tfoot",
  "caption",
] as const;

/**
 * Block-level elements explicitly excluded from CONTENT_BLOCK_SEPARATOR_TAGS
 * with documented rationale. Each entry must explain why the element does not
 * need a word-boundary separator.
 */
const EXCLUDED_BLOCK_ELEMENTS: Record<string, string> = {
  // Structural containers that don't typically separate prose words — their
  // children (p, li, div, etc.) already inject separators.
  address: "Rare in article content; structural wrapper whose children provide separators",
  article: "Structural section wrapper; child block elements provide separators",
  aside: "Structural section wrapper; child block elements provide separators",
  dd: "Definition description; rare in article content, child blocks provide separators",
  details: "Interactive disclosure widget; rare in article content",
  dialog: "Interactive dialog; not used in article prose",
  dl: "Definition list container; child dd/dt elements would need individual handling",
  dt: "Definition term; rare in article content",
  fieldset: "Form container; not used in article prose",
  figure: "Figure container; figcaption already in separator set, image handled separately",
  footer: "Page/section footer; not article prose",
  form: "Form container; not article prose",
  header: "Page/section header; not article prose",
  hgroup: "Heading group container; child headings already in separator set",
  hr: "Horizontal rule; void element with no text content",
  main: "Structural container; child block elements provide separators",
  nav: "Navigation container; not article prose",
  ol: "Ordered list container; child li elements already in separator set",
  pre: "Preformatted text; rare in article content, whitespace is preserved as-is",
  search: "Search landmark; not article prose",
  section: "Structural section wrapper; child block elements provide separators",
  summary: "Summary for details element; rare in article content",
  table: "Table container; child tr/td/th already in separator set",
  ul: "Unordered list container; child li elements already in separator set",
  thead: "Table header group; child tr/td/th already in separator set",
  tbody: "Table body group; child tr/td/th already in separator set",
  tfoot: "Table footer group; child tr/td/th already in separator set",
  caption: "Table caption; rare, and table cell separators handle table content",
};

test("every HTML block-level element is either in CONTENT_BLOCK_SEPARATOR_TAGS or explicitly excluded", () => {
  const missingElements: string[] = [];

  for (const tag of HTML_BLOCK_LEVEL_ELEMENTS) {
    if (!CONTENT_BLOCK_SEPARATOR_TAGS.has(tag) && !(tag in EXCLUDED_BLOCK_ELEMENTS)) {
      missingElements.push(tag);
    }
  }

  assert.equal(
    missingElements.length,
    0,
    `Block-level elements missing from both CONTENT_BLOCK_SEPARATOR_TAGS and EXCLUDED_BLOCK_ELEMENTS: ${missingElements.join(", ")}.\n` +
      `Add each to CONTENT_BLOCK_SEPARATOR_TAGS (if it separates prose words) or to EXCLUDED_BLOCK_ELEMENTS (with rationale).`,
  );
});

test("CONTENT_BLOCK_SEPARATOR_TAGS contains no unrecognized elements", () => {
  const allKnown = new Set<string>([
    ...HTML_BLOCK_LEVEL_ELEMENTS,
    ...Object.keys(EXCLUDED_BLOCK_ELEMENTS),
  ]);

  const unrecognized: string[] = [];
  for (const tag of CONTENT_BLOCK_SEPARATOR_TAGS) {
    if (!allKnown.has(tag)) {
      unrecognized.push(tag);
    }
  }

  assert.equal(
    unrecognized.length,
    0,
    `CONTENT_BLOCK_SEPARATOR_TAGS contains elements not in the HTML block-level list: ${unrecognized.join(", ")}.\n` +
      `Either add them to HTML_BLOCK_LEVEL_ELEMENTS or remove from CONTENT_BLOCK_SEPARATOR_TAGS.`,
  );
});
