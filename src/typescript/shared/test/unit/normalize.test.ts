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

test("hashContent produces 64-character lowercase hex string", async () => {
  const hash = await hashContent("test");
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test("hashContent produces different hashes for different inputs", async () => {
  const [a, b] = await Promise.all([hashContent("hello"), hashContent("world")]);
  assert.notEqual(a, b);
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
