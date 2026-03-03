import assert from "node:assert/strict";
import { test } from "node:test";
import { extractImagePlaceholdersFromMarkdown } from "../../src/lib/services/markdown-resolution.js";

test("extractImagePlaceholdersFromMarkdown extracts placeholders in document order", () => {
  const md = "Text [IMAGE:0] more text [IMAGE:1] end [IMAGE:2]";
  const result = extractImagePlaceholdersFromMarkdown(md);

  assert.equal(result.length, 3);
  assert.equal(result[0]?.index, 0);
  assert.equal(result[1]?.index, 1);
  assert.equal(result[2]?.index, 2);
});

test("extractImagePlaceholdersFromMarkdown preserves out-of-order indices", () => {
  const md = "[IMAGE:5] first [IMAGE:2] second [IMAGE:10]";
  const result = extractImagePlaceholdersFromMarkdown(md);

  assert.equal(result.length, 3);
  assert.equal(result[0]?.index, 5);
  assert.equal(result[1]?.index, 2);
  assert.equal(result[2]?.index, 10);
});

test("extractImagePlaceholdersFromMarkdown returns empty for no placeholders", () => {
  assert.deepEqual(extractImagePlaceholdersFromMarkdown("Just plain text with no images"), []);
});

test("extractImagePlaceholdersFromMarkdown returns empty for empty string", () => {
  assert.deepEqual(extractImagePlaceholdersFromMarkdown(""), []);
});

test("extractImagePlaceholdersFromMarkdown ignores malformed placeholders", () => {
  // [IMAGE:abc] has non-digit content and should not match \d+
  const md = "[IMAGE:0] [IMAGE:abc] [IMAGE:] [IMAGE:99]";
  const result = extractImagePlaceholdersFromMarkdown(md);

  assert.equal(result.length, 2);
  assert.equal(result[0]?.index, 0);
  assert.equal(result[1]?.index, 99);
});

test("extractImagePlaceholdersFromMarkdown handles duplicate indices", () => {
  const md = "[IMAGE:0] duplicate [IMAGE:0] here";
  const result = extractImagePlaceholdersFromMarkdown(md);

  assert.equal(result.length, 2);
  assert.equal(result[0]?.index, 0);
  assert.equal(result[1]?.index, 0);
});

test("extractImagePlaceholdersFromMarkdown sets sourceUrl to empty string", () => {
  // sourceUrl is not recoverable from markdown; the input builder must
  // match by index, not URL.
  const result = extractImagePlaceholdersFromMarkdown("[IMAGE:3]");
  assert.equal(result.length, 1);
  assert.equal(result[0]?.sourceUrl, "");
});

test("extractImagePlaceholdersFromMarkdown ignores bracket patterns that are not image placeholders", () => {
  const md = "See [link](url) and [IMAGE:0] and [not-an-image:1]";
  const result = extractImagePlaceholdersFromMarkdown(md);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.index, 0);
});
