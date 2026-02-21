import assert from "node:assert/strict";
import { test } from "node:test";
import { hashContent, normalizeContent } from "../../src/normalize.js";

test(
  "normalizeContent removes zero-width chars, collapses whitespace, and trims",
  () => {
    const raw = "  Cafe\u0301\u200B   is \n\t great\uFEFF  ";

    assert.equal(normalizeContent(raw), "Caf\u00E9 is great");
  },
);

test("normalizeContent is idempotent", () => {
  const raw = "\u200BCafe\u0301\n\nrocks\t";
  const normalizedOnce = normalizeContent(raw);
  const normalizedTwice = normalizeContent(normalizedOnce);

  assert.equal(normalizedOnce, normalizedTwice);
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
