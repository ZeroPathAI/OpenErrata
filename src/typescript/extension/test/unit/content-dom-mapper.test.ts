import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { normalizeContent, type InvestigationClaim } from "@openerrata/shared";
import {
  buildNormalizedTextIndex,
  extractFilteredText,
  mapClaimsToDom,
} from "../../src/content/dom-mapper.js";

function installDom(html: string): () => void {
  const dom = new JSDOM(html, { url: "https://example.com" });
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNode = globalThis.Node;
  const originalText = globalThis.Text;
  const originalElement = globalThis.Element;
  const originalNodeFilter = globalThis.NodeFilter;
  const originalRange = globalThis.Range;

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    Text: dom.window.Text,
    Element: dom.window.Element,
    NodeFilter: dom.window.NodeFilter,
    Range: dom.window.Range,
  });

  return () => {
    dom.window.close();
    Object.assign(globalThis, {
      window: originalWindow,
      document: originalDocument,
      Node: originalNode,
      Text: originalText,
      Element: originalElement,
      NodeFilter: originalNodeFilter,
      Range: originalRange,
    });
  };
}

function createClaim(text: string, context: string): InvestigationClaim {
  return {
    id: "claim-dom-1" as InvestigationClaim["id"],
    text,
    context,
    summary: "Claim summary",
    reasoning: "Claim reasoning",
    sources: [
      {
        url: "https://example.com/source",
        title: "Source",
        snippet: "Snippet",
      },
    ],
  };
}

// ── Normalization parity (structural enforcement for Bug 1) ──────────────
//
// buildNormalizedTextIndex reimplements normalizeContent's transformations
// character-by-character with position tracking. If the two diverge (e.g. a
// new normalization step is added to normalizeContent but not to the index
// builder), claims silently fall through to O(n²) fuzzy search. This test
// structurally prevents that by asserting parity across a comprehensive set
// of inputs covering every normalization step.

const NORMALIZATION_PARITY_CASES: readonly { label: string; input: string }[] = [
  { label: "plain ASCII", input: "Hello world" },
  { label: "leading/trailing whitespace", input: "  Hello world  " },
  { label: "collapsed internal whitespace", input: "Hello   \t\n  world" },
  { label: "typographic double quotes", input: "\u201CHello\u201D" },
  { label: "typographic single quotes", input: "it\u2019s a \u2018test\u2019" },
  { label: "em dash", input: "word\u2014word" },
  { label: "en dash", input: "word\u2013word" },
  { label: "horizontal ellipsis", input: "wait\u2026" },
  { label: "mixed typographic", input: "\u201CHello,\u201D she said\u2014it\u2019s a test\u2026" },
  { label: "zero-width chars", input: "he\u200Bllo\u200Cwo\u200Drld\uFEFF" },
  { label: "zero-width after whitespace (trailing)", input: "a \u200B" },
  { label: "zero-width between whitespace runs", input: "hello \u200B world" },
  { label: "zero-width before leading text", input: "\u200B a" },
  { label: "astral emoji", input: "Prefix 😀 target text suffix." },
  { label: "surrogate pair sequence", input: "a\uD83D\uDE00b\uD83E\uDD14c" },
  { label: "NFC precomposed vs decomposed", input: "caf\u00E9" },
  { label: "NFD combining sequence", input: "cafe\u0301" },
  { label: "all dashes", input: "\u2010\u2011\u2012\u2013\u2014\u2015" },
  { label: "empty string", input: "" },
  { label: "whitespace only", input: "   \t\n  " },
  { label: "single character", input: "x" },
  {
    label: "long mixed content",
    input: "The \u201Cquick\u201D brown\u2014fox\u2026 jumps! Over the 😀 lazy\u2019s dog.",
  },
];

for (const { label, input } of NORMALIZATION_PARITY_CASES) {
  test(`buildNormalizedTextIndex matches normalizeContent: ${label}`, () => {
    const indexed = buildNormalizedTextIndex(input);
    const expected = normalizeContent(input);
    assert.equal(
      indexed.normalized,
      expected,
      `Normalization parity failed for "${label}":\n` +
        `  input:    ${JSON.stringify(input)}\n` +
        `  indexed:  ${JSON.stringify(indexed.normalized)}\n` +
        `  expected: ${JSON.stringify(expected)}`,
    );
  });
}

// ── DOM mapping tests ────────────────────────────────────────────────────

test("mapClaimsToDom preserves UTF-16 offset alignment after astral emoji", () => {
  const restoreDom = installDom(
    "<!doctype html><html><body><article id='root'>Prefix 😀 target text suffix.</article></body></html>",
  );

  try {
    const root = document.getElementById("root");
    if (!(root instanceof Element)) {
      throw new Error("Missing #root test fixture");
    }

    const claimText = "target text";
    const [annotation] = mapClaimsToDom(
      [createClaim(claimText, "Prefix 😀 target text suffix.")],
      root,
    );
    if (annotation === undefined) {
      throw new Error("Expected one annotation result");
    }

    assert.equal(annotation.matched, true);
    assert.notEqual(annotation.range, null);
    assert.equal(annotation.range?.toString(), claimText);
  } finally {
    restoreDom();
  }
});

test("mapClaimsToDom matches claims through typographic characters without fuzzy fallback", () => {
  // Regression: commit 4359def added typographic normalization to normalizeContent()
  // but not to buildNormalizedTextIndex(). This caused curly quotes in page text to
  // mismatch straight quotes in claim text, forcing every claim into the expensive
  // O(n^2) fuzzy Levenshtein search and freezing the page.
  const restoreDom = installDom(
    '<!doctype html><html><body><article id="root">' +
      "\u201CHello,\u201D she said\u2014it\u2019s a test\u2026 with dashes\u2013and more." +
      "</article></body></html>",
  );

  try {
    const root = document.getElementById("root");
    if (!(root instanceof Element)) {
      throw new Error("Missing #root test fixture");
    }

    // Claim text uses ASCII equivalents (as normalizeContent would produce),
    // page text uses typographic Unicode. Tier 1 exact match must succeed.
    const claim = createClaim('"Hello," she said-it\'s a test... with dashes-and more.', "");
    const [annotation] = mapClaimsToDom([claim], root, { allowFuzzy: false });
    if (annotation === undefined) {
      throw new Error("Expected one annotation result");
    }

    assert.equal(annotation.matched, true, "Typographic chars must match via tier 1, not fuzzy");
    assert.notEqual(annotation.range, null);
  } finally {
    restoreDom();
  }
});

test("mapClaimsToDom falls back to first occurrence when claim text is non-unique", () => {
  // When claim text appears multiple times in the article, tier 1 (unique exact)
  // rejects the match. If context is empty or doesn't help, first-occurrence
  // fallback should match without falling through to the expensive O(n²) fuzzy
  // search. First-occurrence is an approximate-matching tier (gated behind
  // allowFuzzy, which defaults to true).
  const restoreDom = installDom(
    "<!doctype html><html><body><article id='root'>" +
      "North America is a continent. North America has many countries." +
      "</article></body></html>",
  );

  try {
    const root = document.getElementById("root");
    if (!(root instanceof Element)) {
      throw new Error("Missing #root test fixture");
    }

    // "North America" appears twice — tier 1 rejects (non-unique), no context
    // provided so tier 2 is skipped, first-occurrence fallback should match.
    const claim = createClaim("North America", "");
    const [annotation] = mapClaimsToDom([claim], root);
    if (annotation === undefined) {
      throw new Error("Expected one annotation result");
    }

    assert.equal(annotation.matched, true, "Non-unique text must match via first occurrence");
    assert.notEqual(annotation.range, null);
    assert.equal(annotation.range?.toString(), "North America");
  } finally {
    restoreDom();
  }
});

test("mapClaimsToDom can disable approximate matching via allowFuzzy: false", () => {
  const restoreDom = installDom(
    "<!doctype html><html><body><article id='root'>The quick brown fox jumps over the lazy dog.</article></body></html>",
  );

  try {
    const root = document.getElementById("root");
    if (!(root instanceof Element)) {
      throw new Error("Missing #root test fixture");
    }

    // "quick brown fox jumps over lazy dog" is NOT a substring of the page text
    // (page has "the" before "lazy"), so tiers 1-2 fail. With allowFuzzy: true
    // (default), approximate tiers (first-occurrence + Levenshtein) can match.
    // With allowFuzzy: false, all approximate tiers are skipped.
    const nearMatchClaim = createClaim("quick brown fox jumps over lazy dog", "");

    const [fuzzyEnabled] = mapClaimsToDom([nearMatchClaim], root);
    if (fuzzyEnabled === undefined) {
      throw new Error("Expected one annotation result with fuzzy enabled");
    }
    assert.equal(fuzzyEnabled.matched, true);

    const [fuzzyDisabled] = mapClaimsToDom([nearMatchClaim], root, { allowFuzzy: false });
    if (fuzzyDisabled === undefined) {
      throw new Error("Expected one annotation result with fuzzy disabled");
    }
    assert.equal(fuzzyDisabled.matched, false);
  } finally {
    restoreDom();
  }
});

test("mapClaimsToDom strict mode rejects non-unique matches without disambiguating context", () => {
  // With allowFuzzy: false, non-unique text that can't be disambiguated by
  // context should NOT match — first-occurrence fallback is gated behind
  // allowFuzzy. This ensures focusClaim (which uses allowFuzzy: false) only
  // scrolls to high-confidence positions.
  const restoreDom = installDom(
    "<!doctype html><html><body><article id='root'>" +
      "North America is a continent. North America has many countries." +
      "</article></body></html>",
  );

  try {
    const root = document.getElementById("root");
    if (!(root instanceof Element)) {
      throw new Error("Missing #root test fixture");
    }

    // "North America" appears twice, no context → tier 1 rejects, tier 2 skips,
    // and with allowFuzzy: false all approximate tiers are skipped.
    const claim = createClaim("North America", "");
    const [annotation] = mapClaimsToDom([claim], root, { allowFuzzy: false });
    if (annotation === undefined) {
      throw new Error("Expected one annotation result");
    }

    assert.equal(
      annotation.matched,
      false,
      "Non-unique text without context must NOT match in strict mode",
    );
  } finally {
    restoreDom();
  }
});

// ── Element exclusion filter tests ────────────────────────────────────────
//
// Wikipedia's live DOM contains citation superscripts like [107] inside
// <sup class="reference"> elements. The server strips these before generating
// claims, so verbatim claim text can't be found in the raw DOM textContent.
// The shouldExcludeElement filter makes mapClaimsToDom skip these elements.

test("mapClaimsToDom matches claim through excluded <sup class='reference'> with filter", () => {
  // Simulates Wikipedia DOM with inline citation superscripts
  const restoreDom = installDom(
    '<!doctype html><html><body><article id="root">' +
      'NAFTA was replaced<sup class="reference">[107]</sup> by the USMCA in 2020.' +
      "</article></body></html>",
  );

  try {
    const root = document.getElementById("root");
    if (!(root instanceof Element)) {
      throw new Error("Missing #root test fixture");
    }

    const claim = createClaim("NAFTA was replaced by the USMCA in 2020.", "");

    // Without filter: claim text doesn't match because "[107]" is in the way
    const [withoutFilter] = mapClaimsToDom([claim], root, { allowFuzzy: false });
    if (withoutFilter === undefined) {
      throw new Error("Expected one annotation result without filter");
    }
    assert.equal(withoutFilter.matched, false, "Should NOT match without filter");

    // With filter: excluded elements are skipped, claim text matches
    const shouldExclude = (el: Element): boolean =>
      el.tagName === "SUP" && el.classList.contains("reference");

    const [withFilter] = mapClaimsToDom([claim], root, {
      allowFuzzy: false,
      shouldExcludeElement: shouldExclude,
    });
    if (withFilter === undefined) {
      throw new Error("Expected one annotation result with filter");
    }
    assert.equal(withFilter.matched, true, "Should match with filter excluding <sup>");
    assert.notEqual(withFilter.range, null);
    // Range.toString() includes all text in the range (including excluded nodes),
    // but the important thing is the range was created at the correct position.
    const rangeText = withFilter.range?.toString() ?? "";
    assert.ok(
      rangeText.startsWith("NAFTA was replaced"),
      "Range should start at 'NAFTA was replaced'",
    );
    assert.ok(
      rangeText.endsWith("by the USMCA in 2020."),
      "Range should end at 'by the USMCA in 2020.'",
    );
  } finally {
    restoreDom();
  }
});

test("mapClaimsToDom Range spans correctly around excluded elements", () => {
  // Multiple excluded elements scattered through the text
  const restoreDom = installDom(
    '<!doctype html><html><body><article id="root">' +
      "The agreement" +
      '<sup class="reference">[1]</sup>' +
      " was signed" +
      '<sup class="reference">[2]</sup>' +
      " in Paris." +
      "</article></body></html>",
  );

  try {
    const root = document.getElementById("root");
    if (!(root instanceof Element)) {
      throw new Error("Missing #root test fixture");
    }

    const shouldExclude = (el: Element): boolean =>
      el.tagName === "SUP" && el.classList.contains("reference");

    const claim = createClaim("The agreement was signed in Paris.", "");
    const [annotation] = mapClaimsToDom([claim], root, {
      allowFuzzy: false,
      shouldExcludeElement: shouldExclude,
    });
    if (annotation === undefined) {
      throw new Error("Expected one annotation result");
    }

    assert.equal(annotation.matched, true);
    assert.notEqual(annotation.range, null);
    // Range.toString() includes all text in the range including excluded nodes.
    // Verify the range starts and ends at the correct prose boundaries.
    const rangeText = annotation.range?.toString() ?? "";
    assert.ok(rangeText.startsWith("The agreement"), "Range should start at 'The agreement'");
    assert.ok(rangeText.endsWith("in Paris."), "Range should end at 'in Paris.'");
  } finally {
    restoreDom();
  }
});

test("mapClaimsToDom without filter preserves existing behavior (regression)", () => {
  // Without filter, the text "[107]" IS part of textContent and should be matchable
  const restoreDom = installDom(
    '<!doctype html><html><body><article id="root">' +
      'NAFTA was replaced<sup class="reference">[107]</sup> by the USMCA.' +
      "</article></body></html>",
  );

  try {
    const root = document.getElementById("root");
    if (!(root instanceof Element)) {
      throw new Error("Missing #root test fixture");
    }

    // This claim text includes the citation number, matching the unfiltered DOM
    const claim = createClaim("NAFTA was replaced[107] by the USMCA.", "");
    const [annotation] = mapClaimsToDom([claim], root, { allowFuzzy: false });
    if (annotation === undefined) {
      throw new Error("Expected one annotation result");
    }

    assert.equal(annotation.matched, true, "Without filter, full textContent should be matched");
    assert.notEqual(annotation.range, null);
  } finally {
    restoreDom();
  }
});

// ── Section-level exclusion tests ─────────────────────────────────────────

test("extractFilteredText excludes section-level content under excluded headings", () => {
  // Simulates Wikipedia-like structure with a "References" section that should
  // be excluded at the section level (heading + all sibling content until the
  // next same-or-higher-level heading).
  const restoreDom = installDom(
    '<!doctype html><html><body><article id="root">' +
      "<p>Main article content about North America.</p>" +
      "<h2>Geography</h2>" +
      "<p>Geographic details here.</p>" +
      "<h2>References</h2>" +
      '<ol class="references"><li>Reference one</li><li>Reference two</li></ol>' +
      "<h2>See also</h2>" +
      "<p>See also content.</p>" +
      "</article></body></html>",
  );

  try {
    const root = document.getElementById("root");
    if (!(root instanceof Element)) {
      throw new Error("Missing #root test fixture");
    }

    // Section-level filter: excludes the References heading and its content
    // siblings, plus citation superscripts at the element level.
    const referencesHeading = root.querySelector("h2:nth-of-type(2)");
    const referencesContent = root.querySelector("ol.references");
    const excludedElements = new Set<Element>();
    if (referencesHeading) excludedElements.add(referencesHeading);
    if (referencesContent) excludedElements.add(referencesContent);

    const shouldExclude = (el: Element): boolean => {
      // Element-level: citation superscripts
      if (el.tagName === "SUP" && el.classList.contains("reference")) return true;
      // Section-level: precomputed excluded section elements
      return excludedElements.has(el);
    };

    const filteredText = extractFilteredText(root, shouldExclude);
    assert.ok(filteredText.includes("Main article content"), "Should include main content");
    assert.ok(filteredText.includes("Geographic details"), "Should include Geography section");
    assert.ok(!filteredText.includes("Reference one"), "Should exclude References section content");
    assert.ok(
      filteredText.includes("See also content"),
      "Should include See also section (not excluded)",
    );
  } finally {
    restoreDom();
  }
});

test("extractFilteredText skips citation superscripts at element level", () => {
  const restoreDom = installDom(
    '<!doctype html><html><body><article id="root">' +
      'The treaty was signed<sup class="reference">[1]</sup> in 2020' +
      '<sup class="reference">[2]</sup> by all parties.' +
      "</article></body></html>",
  );

  try {
    const root = document.getElementById("root");
    if (!(root instanceof Element)) {
      throw new Error("Missing #root test fixture");
    }

    const shouldExclude = (el: Element): boolean =>
      el.tagName === "SUP" && el.classList.contains("reference");

    const filteredText = extractFilteredText(root, shouldExclude);
    assert.equal(
      filteredText,
      "The treaty was signed in 2020 by all parties.",
      "Filtered text should omit citation numbers but preserve surrounding prose",
    );

    // Verify the unfiltered text includes citations
    const unfilteredText = root.textContent;
    assert.ok(
      unfilteredText.includes("[1]") && unfilteredText.includes("[2]"),
      "Unfiltered textContent should include citation numbers",
    );
  } finally {
    restoreDom();
  }
});
