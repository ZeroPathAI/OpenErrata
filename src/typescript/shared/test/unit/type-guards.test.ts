import assert from "node:assert/strict";
import { test } from "node:test";
import { isNonNullObject } from "../../src/type-guards.js";

test("isNonNullObject returns true for plain objects", () => {
  assert.equal(isNonNullObject({}), true);
  assert.equal(isNonNullObject({ key: "value" }), true);
  assert.equal(isNonNullObject(Object.create(null)), true);
});

test("isNonNullObject returns false for null", () => {
  assert.equal(isNonNullObject(null), false);
});

test("isNonNullObject returns false for arrays", () => {
  assert.equal(isNonNullObject([]), false);
  assert.equal(isNonNullObject([1, 2, 3]), false);
});

test("isNonNullObject returns false for primitives", () => {
  assert.equal(isNonNullObject(undefined), false);
  assert.equal(isNonNullObject(0), false);
  assert.equal(isNonNullObject(""), false);
  assert.equal(isNonNullObject(false), false);
  assert.equal(isNonNullObject(Symbol("test")), false);
});

test("isNonNullObject narrows type for property access", () => {
  const value: unknown = { message: "hello" };
  if (isNonNullObject(value)) {
    assert.equal(value["message"], "hello");
  } else {
    assert.fail("Expected isNonNullObject to return true for a plain object");
  }
});
