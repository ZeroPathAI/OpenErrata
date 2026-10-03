import assert from "node:assert/strict";
import { test } from "node:test";
import { WORD_COUNT_LIMIT } from "@openerrata/shared";
import { wordCount } from "../../src/lib/services/word-count.js";

/**
 * wordCount is what ContentBlob.wordCount stores, and investigateNow and the
 * selector compare it against WORD_COUNT_LIMIT, so the count must be stable
 * across whitespace kinds and the limit boundary must be exact.
 */

test("wordCount splits on any run of whitespace, including non-breaking space", () => {
  assert.equal(wordCount("hello world"), 2);
  assert.equal(wordCount("hello   world\t\tfoo\nbar"), 4);
  assert.equal(wordCount("hello world"), 2);
});

test("wordCount returns 0 for empty and whitespace-only text", () => {
  assert.equal(wordCount(""), 0);
  assert.equal(wordCount("   \t\n  "), 0);
  assert.equal(wordCount("\n\n\n"), 0);
});

test("wordCount treats punctuation-joined and non-Latin tokens as single words", () => {
  assert.equal(wordCount("mother-in-law it's don't"), 3);
  assert.equal(wordCount("Hello, world!"), 2);
  assert.equal(wordCount("你好 世界"), 2);
  assert.equal(wordCount("🎉 🎊 🎈"), 3);
  assert.equal(wordCount("a".repeat(10_000)), 1);
});

test("wordCount is exact at the WORD_COUNT_LIMIT boundary", () => {
  const words = (count: number): string =>
    Array.from({ length: count }, (_, i) => `word${i.toString()}`).join(" ");
  assert.equal(wordCount(words(WORD_COUNT_LIMIT)), WORD_COUNT_LIMIT);
  assert.equal(wordCount(words(WORD_COUNT_LIMIT + 1)), WORD_COUNT_LIMIT + 1);
});
