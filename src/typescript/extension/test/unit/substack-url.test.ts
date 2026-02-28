import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSubstackPostSlug, isSubstackPostPath } from "../../src/lib/substack-url.js";

test("extractSubstackPostSlug returns slug for canonical Substack post paths", () => {
  assert.equal(extractSubstackPostSlug("/p/example-post"), "example-post");
  assert.equal(extractSubstackPostSlug("/P/Case-Insensitive"), "Case-Insensitive");
  assert.equal(extractSubstackPostSlug("/p/example-post?foo=bar"), "example-post");
});

test("extractSubstackPostSlug returns null for non-post paths", () => {
  assert.equal(extractSubstackPostSlug("/"), null);
  assert.equal(extractSubstackPostSlug("/archive"), null);
  assert.equal(extractSubstackPostSlug("/p/"), null);
});

test("isSubstackPostPath reflects slug extraction result", () => {
  assert.equal(isSubstackPostPath("/p/hello-world"), true);
  assert.equal(isSubstackPostPath("/posts/hello-world"), false);
});
