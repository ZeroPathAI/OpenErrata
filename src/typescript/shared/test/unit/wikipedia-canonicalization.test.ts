import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isExcludedWikipediaSectionTitle,
  shouldExcludeWikipediaElement,
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
