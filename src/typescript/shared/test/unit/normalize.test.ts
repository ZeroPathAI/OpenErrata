import assert from "node:assert/strict";
import { test } from "node:test";
import { hashContent, normalizeContent } from "../../src/normalize.js";
import { sha256HashSchema } from "../../src/schemas.js";

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

test("hashContent returns the known SHA-256 digest for a fixed string", async () => {
  const digest = await hashContent("hello");

  assert.equal(
    digest,
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
  assert.equal(sha256HashSchema.safeParse(digest).success, true);
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
