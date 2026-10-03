import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContent } from "@openerrata/shared";
import {
  buildNormalizedTextIndex,
  normalizedLengthBefore,
  rawSpanOf,
} from "../../src/content/normalized-text-index.js";
import { createDeterministicRandom, randomInt } from "../helpers/fuzz-utils.js";

// The index builder reimplements normalizeContent's transformations
// character-by-character with position tracking. If the two diverge, claims
// stop matching and image offsets drift; these cases cover every
// normalization step.
const NORMALIZATION_PARITY_CASES: readonly { label: string; input: string }[] = [
  { label: "plain ASCII", input: "Hello world" },
  { label: "leading/trailing whitespace", input: "  Hello world  " },
  { label: "collapsed internal whitespace", input: "Hello   \t\n  world" },
  { label: "typographic double quotes", input: "“Hello”" },
  { label: "typographic single quotes", input: "it’s a ‘test’" },
  { label: "em dash", input: "word—word" },
  { label: "en dash", input: "word–word" },
  { label: "horizontal ellipsis", input: "wait…" },
  { label: "mixed typographic", input: "“Hello,” she said—it’s a test…" },
  { label: "zero-width chars", input: "he​llo‌wo‍rld﻿" },
  { label: "zero-width after whitespace (trailing)", input: "a ​" },
  { label: "zero-width between whitespace runs", input: "hello ​ world" },
  { label: "zero-width before leading text", input: "​ a" },
  { label: "astral emoji", input: "Prefix 😀 target text suffix." },
  { label: "surrogate pair sequence", input: "a😀b🤔c" },
  { label: "NFC precomposed vs decomposed", input: "café" },
  { label: "NFD combining sequence", input: "café" },
  { label: "all dashes", input: "‐‑‒–—―" },
  { label: "empty string", input: "" },
  { label: "whitespace only", input: "   \t\n  " },
  { label: "single character", input: "x" },
  {
    label: "long mixed content",
    input: "The “quick” brown—fox… jumps! Over the 😀 lazy’s dog.",
  },
];

for (const { label, input } of NORMALIZATION_PARITY_CASES) {
  test(`buildNormalizedTextIndex matches normalizeContent: ${label}`, () => {
    assert.equal(buildNormalizedTextIndex(input).normalized, normalizeContent(input));
  });
}

const FUZZ_ALPHABET = ["a", "b", "Z", " ", "\n", "\t", "’", "…", "​", "é", "😀", "é"];

function randomText(random: () => number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += FUZZ_ALPHABET[randomInt(random, 0, FUZZ_ALPHABET.length - 1)] ?? "";
  }
  return text;
}

test("normalizedLengthBefore equals the normalized length of every raw prefix", () => {
  const random = createDeterministicRandom(20261002);
  for (let round = 0; round < 300; round += 1) {
    const raw = randomText(random, randomInt(random, 0, 24));
    const index = buildNormalizedTextIndex(raw);
    assert.equal(index.normalized, normalizeContent(raw));
    for (let offset = 0; offset <= raw.length; offset += 1) {
      // Offsets inside a surrogate pair are not positions an element can sit at.
      const code = raw.charCodeAt(offset - 1);
      if (code >= 0xd800 && code <= 0xdbff) continue;
      assert.equal(
        normalizedLengthBefore(index, offset),
        normalizeContent(raw.slice(0, offset)).length,
        `prefix ${JSON.stringify(raw.slice(0, offset))} of ${JSON.stringify(raw)}`,
      );
    }
  }
});

test("rawSpanOf covers whole raw characters, including combining marks and expansions", () => {
  const raw = "  café au lait… ";
  const index = buildNormalizedTextIndex(raw);
  assert.equal(index.normalized, "café au lait...");

  const cafe = rawSpanOf(index, 0, 4);
  assert.deepEqual(cafe && raw.slice(cafe.rawStart, cafe.rawEnd), "café");

  const ellipsis = rawSpanOf(index, index.normalized.length - 3, index.normalized.length);
  assert.deepEqual(ellipsis && raw.slice(ellipsis.rawStart, ellipsis.rawEnd), "…");

  assert.equal(rawSpanOf(index, 2, 2), null);
});
