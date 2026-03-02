import assert from "node:assert/strict";
import { test } from "node:test";
import {
  effectiveHeadingLevel,
  effectiveHeadingText,
  headingLevelFromTag,
  isExcludedWikipediaSectionTitle,
  shouldExcludeWikipediaElement,
  type WikipediaHeadingLevelDescriptor,
  type WikipediaNodeDescriptor,
} from "../../src/wikipedia-canonicalization.js";

test("isExcludedWikipediaSectionTitle normalizes whitespace and casing", () => {
  assert.equal(isExcludedWikipediaSectionTitle("  References  "), true);
  assert.equal(isExcludedWikipediaSectionTitle("Further   Reading"), true);
  assert.equal(isExcludedWikipediaSectionTitle("History"), false);
});

test("shouldExcludeWikipediaElement excludes references-class blocks", () => {
  assert.equal(
    shouldExcludeWikipediaElement({
      tagName: "ol",
      classTokens: ["references"],
    }),
    true,
  );
});

test("shouldExcludeWikipediaElement excludes citation superscripts only", () => {
  assert.equal(
    shouldExcludeWikipediaElement({
      tagName: "sup",
      classTokens: ["reference"],
    }),
    true,
  );
  assert.equal(
    shouldExcludeWikipediaElement({
      tagName: "sup",
      classTokens: [],
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// headingLevelFromTag
// ---------------------------------------------------------------------------

test("headingLevelFromTag parses h2–h6 and rejects non-headings", () => {
  assert.equal(headingLevelFromTag("h2"), 2);
  assert.equal(headingLevelFromTag("H3"), 3);
  assert.equal(headingLevelFromTag("h6"), 6);
  assert.equal(headingLevelFromTag("h1"), null);
  assert.equal(headingLevelFromTag("h7"), null);
  assert.equal(headingLevelFromTag("div"), null);
  assert.equal(headingLevelFromTag("span"), null);
});

// ---------------------------------------------------------------------------
// effectiveHeadingLevel
// ---------------------------------------------------------------------------

/** Heading level detection requires only tag names and classes — no text. */
function levelDescriptor(
  tagName: string,
  classTokens: string[],
  firstChildHeadingTagName?: string,
): WikipediaHeadingLevelDescriptor {
  return {
    tagName,
    classTokens,
    firstChildHeading:
      firstChildHeadingTagName !== undefined ? { tagName: firstChildHeadingTagName } : null,
  };
}

test("effectiveHeadingLevel returns level for direct heading elements", () => {
  assert.equal(effectiveHeadingLevel(levelDescriptor("h2", [])), 2);
  assert.equal(effectiveHeadingLevel(levelDescriptor("H4", [])), 4);
});

test("effectiveHeadingLevel returns level for Parsoid wrapper with inner heading", () => {
  assert.equal(
    effectiveHeadingLevel(levelDescriptor("div", ["mw-heading", "mw-heading3"], "h3")),
    3,
  );
});

test("effectiveHeadingLevel returns null for Parsoid wrapper without inner heading", () => {
  assert.equal(effectiveHeadingLevel(levelDescriptor("div", ["mw-heading"])), null);
});

test("effectiveHeadingLevel returns null for non-heading elements", () => {
  assert.equal(effectiveHeadingLevel(levelDescriptor("p", [])), null);
  assert.equal(effectiveHeadingLevel(levelDescriptor("div", ["some-class"])), null);
});

// ---------------------------------------------------------------------------
// effectiveHeadingText
// ---------------------------------------------------------------------------

test("effectiveHeadingText returns inner heading text for Parsoid wrappers", () => {
  const wrapper: WikipediaNodeDescriptor = {
    tagName: "div",
    classTokens: ["mw-heading", "mw-heading2"],
    textContent: "References[edit]",
    firstChildHeading: { tagName: "h2", textContent: "References" },
  };
  assert.equal(effectiveHeadingText(wrapper), "References");
});

test("effectiveHeadingText returns headline text for legacy headings", () => {
  const heading: WikipediaNodeDescriptor = {
    tagName: "h2",
    classTokens: [],
    textContent: "History[edit]",
    firstChildHeading: null,
  };
  assert.equal(effectiveHeadingText(heading, "History"), "History");
});

test("effectiveHeadingText falls back to full text content for direct headings without headline", () => {
  const heading: WikipediaNodeDescriptor = {
    tagName: "h3",
    classTokens: [],
    textContent: "Early life",
    firstChildHeading: null,
  };
  assert.equal(effectiveHeadingText(heading), "Early life");
});
