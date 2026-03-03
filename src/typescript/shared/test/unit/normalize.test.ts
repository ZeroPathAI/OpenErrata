import assert from "node:assert/strict";
import { test } from "node:test";
import { hashContent, normalizeContent } from "../../src/normalize.js";

test("normalizeContent removes zero-width chars, collapses whitespace, and trims", () => {
  const raw = "  Cafe\u0301\u200B   is \n\t great\uFEFF  ";

  assert.equal(normalizeContent(raw), "Caf\u00E9 is great");
});

test("normalizeContent is idempotent", () => {
  const raw = "\u200BCafe\u0301\n\nrocks\t";
  const normalizedOnce = normalizeContent(raw);
  const normalizedTwice = normalizeContent(normalizedOnce);

  assert.equal(normalizedOnce, normalizedTwice);
});

test("normalizeContent returns empty string for empty input", () => {
  assert.equal(normalizeContent(""), "");
});

test("normalizeContent returns empty string for whitespace-only input", () => {
  assert.equal(normalizeContent("   \t\n\r  "), "");
});

test("normalizeContent collapses non-breaking space as whitespace", () => {
  // U+00A0 (non-breaking space) should be treated as whitespace by \s+
  assert.equal(normalizeContent("hello\u00A0world"), "hello world");
});

test("normalizeContent removes all targeted zero-width characters", () => {
  const zwsp = "\u200B"; // zero-width space
  const zwnj = "\u200C"; // zero-width non-joiner
  const zwj = "\u200D"; // zero-width joiner
  const bom = "\uFEFF"; // byte order mark / zero-width no-break space

  assert.equal(normalizeContent(`a${zwsp}b${zwnj}c${zwj}d${bom}e`), "abcde");
});

test("normalizeContent replaces curly double quotes with straight quotes", () => {
  assert.equal(normalizeContent("\u201CHello,\u201D she said"), '"Hello," she said');
});

test("normalizeContent replaces curly single quotes with straight quotes", () => {
  assert.equal(normalizeContent("it\u2019s a \u2018test\u2019"), "it's a 'test'");
});

test("normalizeContent replaces em and en dashes with hyphens", () => {
  assert.equal(normalizeContent("a\u2014b\u2013c"), "a-b-c");
});

test("normalizeContent replaces Unicode hyphens with ASCII hyphen", () => {
  // U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash, U+2015 horizontal bar
  assert.equal(normalizeContent("\u2010\u2011\u2012\u2015"), "----");
});

test("normalizeContent replaces horizontal ellipsis with three dots", () => {
  assert.equal(normalizeContent("wait\u2026 what"), "wait... what");
});

test("normalizeContent applies typographic replacements together with other steps", () => {
  const raw = "  \u201CSmart\u201D\u200B quotes\u2014and\u2026 dashes  ";
  assert.equal(normalizeContent(raw), '"Smart" quotes-and... dashes');
});

test("hashContent produces 64-character lowercase hex string", async () => {
  const hash = await hashContent("test");
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test("hashContent produces different hashes for different inputs", async () => {
  const [a, b] = await Promise.all([hashContent("hello"), hashContent("world")]);
  assert.notEqual(a, b);
});

// ── Typographic replacement completeness ────────────────────────────────
// Every Unicode code point in TYPOGRAPHIC_REPLACEMENTS must map to its
// documented ASCII equivalent. This catches if someone extends a character
// class regex but forgets to verify the replacement.

test("typographic replacement covers all documented code points", () => {
  // Left double quotation mark → "
  assert.equal(normalizeContent("\u201C"), '"');
  // Right double quotation mark → "
  assert.equal(normalizeContent("\u201D"), '"');
  // Left single quotation mark → '
  assert.equal(normalizeContent("\u2018"), "'");
  // Right single quotation mark → '
  assert.equal(normalizeContent("\u2019"), "'");
  // Hyphen (U+2010) → -
  assert.equal(normalizeContent("\u2010"), "-");
  // Non-breaking hyphen (U+2011) → -
  assert.equal(normalizeContent("\u2011"), "-");
  // Figure dash (U+2012) → -
  assert.equal(normalizeContent("\u2012"), "-");
  // En dash (U+2013) → -
  assert.equal(normalizeContent("\u2013"), "-");
  // Em dash (U+2014) → -
  assert.equal(normalizeContent("\u2014"), "-");
  // Horizontal bar (U+2015) → -
  assert.equal(normalizeContent("\u2015"), "-");
  // Horizontal ellipsis (U+2026) → ...
  assert.equal(normalizeContent("\u2026"), "...");
});

// ── Comprehensive idempotence ───────────────────────────────────────────
// normalizeContent(normalizeContent(x)) === normalizeContent(x) must hold
// for inputs mixing all typographic characters, zero-width characters,
// combining marks, and various whitespace. This extends the basic
// idempotence test above to a comprehensive input.

test("normalizeContent is idempotent under comprehensive typographic + whitespace input", () => {
  const comprehensive = [
    // All typographic quote pairs
    "\u201CHello,\u201D she said. \u2018It\u2019s fine.\u2019",
    // All dash variants in sequence
    "a\u2010b\u2011c\u2012d\u2013e\u2014f\u2015g",
    // Ellipsis with surrounding context
    "wait\u2026 what\u2026",
    // Zero-width characters interspersed
    "\u200Bhello\u200Cworld\u200D\uFEFF",
    // Combining characters (café via combining acute)
    "Cafe\u0301 is great",
    // Mixed whitespace
    "line1\n\tline2\r\nline3   line4",
    // Non-breaking space
    "non\u00A0breaking\u00A0space",
    // All of the above combined
    "\u201CSmart\u201D \u200B quotes\u2014and\u2026 Cafe\u0301\n\tdashes\u2010\u2015",
  ].join(" ");

  const normalizedOnce = normalizeContent(comprehensive);
  const normalizedTwice = normalizeContent(normalizedOnce);

  assert.equal(
    normalizedOnce,
    normalizedTwice,
    "normalizeContent must be idempotent for comprehensive typographic input",
  );
});

test("hashContent hashes exact input bytes without implicit normalization", async () => {
  const normalized = normalizeContent("line one\nline two");
  const rawWithExtraWhitespace = "line one  \nline two";

  const [normalizedHash, rawHash] = await Promise.all([
    hashContent(normalized),
    hashContent(rawWithExtraWhitespace),
  ]);

  assert.notEqual(normalizedHash, rawHash);
});
