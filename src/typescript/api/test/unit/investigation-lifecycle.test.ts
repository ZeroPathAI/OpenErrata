import assert from "node:assert/strict";
import { test } from "node:test";
import { WORD_COUNT_LIMIT } from "@openerrata/shared";
import {
  wordCount,
  InvestigationWordLimitError,
} from "../../src/lib/services/investigation-lifecycle.js";

/**
 * Invariants under test:
 *
 * 1. **wordCount is the gatekeeper for the word limit**: The lifecycle rejects
 *    posts where wordCount(text) > WORD_COUNT_LIMIT. These tests verify the
 *    counting algorithm handles edge cases (mixed whitespace, non-breaking
 *    spaces, Unicode) and that the boundary condition is correct (exactly
 *    WORD_COUNT_LIMIT words passes, WORD_COUNT_LIMIT + 1 fails).
 *
 * 2. **InvestigationWordLimitError carries metadata for the API response**:
 *    The observedWordCount and limit fields are what the caller returns to
 *    the extension to explain the rejection.
 */

// ── wordCount ────────────────────────────────────────────────────────────────

test("wordCount counts words separated by single spaces", () => {
  assert.equal(wordCount("hello world"), 2);
});

test("wordCount counts words across mixed whitespace", () => {
  assert.equal(wordCount("hello   world\t\tfoo\nbar"), 4);
});

test("wordCount returns 0 for empty string", () => {
  assert.equal(wordCount(""), 0);
});

test("wordCount returns 0 for whitespace-only string", () => {
  assert.equal(wordCount("   \t\n  "), 0);
});

test("wordCount counts hyphenated and contracted words as single tokens", () => {
  assert.equal(wordCount("mother-in-law it's don't"), 3);
});

test("wordCount counts punctuation-adjacent text as single tokens", () => {
  assert.equal(wordCount("Hello, world!"), 2);
});

test("wordCount handles non-breaking space as a word separator", () => {
  // \u00A0 is a non-breaking space; \s+ matches it in JavaScript
  assert.equal(wordCount("hello\u00A0world"), 2);
});

test("wordCount handles single word", () => {
  assert.equal(wordCount("hello"), 1);
});

// ── wordCount + WORD_COUNT_LIMIT boundary ────────────────────────────────────

test("wordCount of exactly WORD_COUNT_LIMIT words is at the boundary", () => {
  const text = Array.from({ length: WORD_COUNT_LIMIT }, (_, i) => `word${i.toString()}`).join(" ");
  assert.equal(wordCount(text), WORD_COUNT_LIMIT);
});

test("wordCount boundary: WORD_COUNT_LIMIT + 1 exceeds the limit", () => {
  const count = WORD_COUNT_LIMIT + 1;
  const text = Array.from({ length: count }, (_, i) => `word${i.toString()}`).join(" ");
  assert.equal(wordCount(text), count);
  assert.ok(wordCount(text) > WORD_COUNT_LIMIT);
});

// ── InvestigationWordLimitError ──────────────────────────────────────────────

test("InvestigationWordLimitError stores observedWordCount and limit", () => {
  const error = new InvestigationWordLimitError(15234, 10000);
  assert.equal(error.observedWordCount, 15234);
  assert.equal(error.limit, 10000);
  assert.match(error.message, /10000/);
});

// ── wordCount edge cases ─────────────────────────────────────────────────────

test("wordCount treats Unicode text as individual words", () => {
  assert.equal(wordCount("你好 世界"), 2);
});

test("wordCount counts emoji as words when space-separated", () => {
  assert.equal(wordCount("🎉 🎊 🎈"), 3);
});

test("wordCount handles very long words correctly", () => {
  const longWord = "a".repeat(10_000);
  assert.equal(wordCount(longWord), 1);
});

test("wordCount handles newline-only text", () => {
  assert.equal(wordCount("\n\n\n"), 0);
});
