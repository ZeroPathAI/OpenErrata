import assert from "node:assert/strict";
import { test } from "node:test";
import { toDate, toOptionalDate } from "../../src/lib/date.js";

test("toDate throws on invalid ISO timestamps", () => {
  assert.throws(() => toDate("not-a-date"), /Invalid ISO timestamp/);
});

test("toOptionalDate returns null for nullish values", () => {
  assert.equal(toOptionalDate(null), null);
  assert.equal(toOptionalDate(undefined), null);
});

test("toOptionalDate returns null for invalid non-strict timestamps", () => {
  assert.equal(toOptionalDate("not-a-date"), null);
});

test("toOptionalDate strict mode throws on invalid timestamps", () => {
  assert.throws(() => toOptionalDate("not-a-date", { strict: true }), /Invalid ISO timestamp/);
});
