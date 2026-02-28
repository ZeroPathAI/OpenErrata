import assert from "node:assert/strict";
import { test } from "node:test";
import { trimToOptionalNonEmpty } from "../../src/optional-non-empty.js";

test("trimToOptionalNonEmpty trims and preserves non-empty values", () => {
  assert.equal(trimToOptionalNonEmpty(" value "), "value");
  assert.equal(trimToOptionalNonEmpty("0"), "0");
});

test("trimToOptionalNonEmpty returns undefined for empty or missing values", () => {
  assert.equal(trimToOptionalNonEmpty(""), undefined);
  assert.equal(trimToOptionalNonEmpty("   \t\n  "), undefined);
  assert.equal(trimToOptionalNonEmpty(null), undefined);
  assert.equal(trimToOptionalNonEmpty(undefined), undefined);
});
