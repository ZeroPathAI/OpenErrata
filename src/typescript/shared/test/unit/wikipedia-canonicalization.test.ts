import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WIKIPEDIA_EXCLUDED_SECTION_TITLES,
  effectiveHeadingLevel,
  effectiveHeadingText,
  headingLevelFromTag,
  isExcludedWikipediaSectionTitle,
  normalizeWikipediaSectionTitle,
  shouldExcludeWikipediaElement,
  type WikipediaHeadingLevelDescriptor,
  type WikipediaNodeDescriptor,
} from "../../src/wikipedia-canonicalization.js";

function element(tagName: string, classTokens: string[] = [], role: string | null = null) {
  return { tagName, classTokens, role };
}

test("isExcludedWikipediaSectionTitle normalizes whitespace and casing", () => {
  assert.equal(isExcludedWikipediaSectionTitle("  References  "), true);
  assert.equal(isExcludedWikipediaSectionTitle("Further   Reading"), true);
  assert.equal(isExcludedWikipediaSectionTitle("History"), false);
});

test("isExcludedWikipediaSectionTitle matches the appendix titles of the largest wikis", () => {
  for (const title of [
    "Einzelnachweise",
    "Weblinks",
    "Notes et références",
    "Liens externes",
    "Enlaces externos",
    "Collegamenti esterni",
    "Ligações externas",
    "Externe links",
    "Przypisy",
    "Примечания",
    "脚注",
    "外部リンク",
    "參考文獻",
    "外部链接",
  ]) {
    assert.equal(isExcludedWikipediaSectionTitle(title), true, title);
  }
});

test("isExcludedWikipediaSectionTitle keeps See also sections in every language, as English does", () => {
  for (const title of [
    "See also",
    "Siehe auch",
    "Voir aussi",
    "Véase también",
    "Voci correlate",
    "関連項目",
  ]) {
    assert.equal(isExcludedWikipediaSectionTitle(title), false, title);
  }
});

test("excluded section titles are stored in their normalized form", () => {
  // Matching compares normalized heading text against the list verbatim.
  for (const title of WIKIPEDIA_EXCLUDED_SECTION_TITLES) {
    assert.equal(normalizeWikipediaSectionTitle(title), title);
  }
});

test("shouldExcludeWikipediaElement excludes references-class blocks", () => {
  assert.equal(shouldExcludeWikipediaElement(element("ol", ["references"])), true);
});

test("shouldExcludeWikipediaElement excludes citation superscripts only", () => {
  assert.equal(shouldExcludeWikipediaElement(element("sup", ["reference"])), true);
  assert.equal(shouldExcludeWikipediaElement(element("sup")), false);
});

test("shouldExcludeWikipediaElement excludes navigation landmarks whatever their classes", () => {
  // de "Hauptartikel" links, nl navboxes, en series sidebars.
  assert.equal(shouldExcludeWikipediaElement(element("div", ["hauptartikel"], "navigation")), true);
  assert.equal(shouldExcludeWikipediaElement(element("table", ["sidebar"], " Navigation ")), true);
  assert.equal(shouldExcludeWikipediaElement(element("table", ["infobox"], "presentation")), false);
  assert.equal(shouldExcludeWikipediaElement(element("div", [], "note")), false);
});

test("shouldExcludeWikipediaElement excludes the cross-wiki non-prose conventions", () => {
  // Hatnotes, navboxes and authority control are kept out of search.
  assert.equal(
    shouldExcludeWikipediaElement(element("div", ["hatnote", "navigation-not-searchable"], "note")),
    true,
  );
  // Banners and person-data tables are about the article, not of it.
  assert.equal(shouldExcludeWikipediaElement(element("table", ["metadata", "ambox"])), true);
  assert.equal(shouldExcludeWikipediaElement(element("p")), false);
  assert.equal(shouldExcludeWikipediaElement(element("table", ["wikitable"])), false);
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
