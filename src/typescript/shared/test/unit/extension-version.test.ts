import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareExtensionVersions,
  isExtensionVersionAtLeast,
  parseExtensionVersion,
} from "../../src/extension-version.js";

test("parseExtensionVersion parses one to four numeric segments and pads to four components", () => {
  assert.deepEqual(parseExtensionVersion("1"), [1, 0, 0, 0]);
  assert.deepEqual(parseExtensionVersion("1.2"), [1, 2, 0, 0]);
  assert.deepEqual(parseExtensionVersion("1.2.3"), [1, 2, 3, 0]);
  assert.deepEqual(parseExtensionVersion("1.2.3.4"), [1, 2, 3, 4]);
  assert.deepEqual(parseExtensionVersion("  7.8.9  "), [7, 8, 9, 0]);
});

test("parseExtensionVersion rejects invalid extension version strings", () => {
  assert.equal(parseExtensionVersion(""), null);
  assert.equal(parseExtensionVersion("1.2.3.4.5"), null);
  assert.equal(parseExtensionVersion("1.-2.3"), null);
  assert.equal(parseExtensionVersion("1.a.3"), null);
  assert.equal(parseExtensionVersion("65536"), null);
});

test("compareExtensionVersions compares normalized four-segment versions", () => {
  assert.equal(compareExtensionVersions("1.2.3", "1.2.3.0"), 0);
  assert.equal(compareExtensionVersions("1.2.4", "1.2.3.999"), 1);
  assert.equal(compareExtensionVersions("1.2.3", "1.2.4"), -1);
});

test("compareExtensionVersions returns null when either version is invalid", () => {
  assert.equal(compareExtensionVersions("invalid", "1.0"), null);
  assert.equal(compareExtensionVersions("1.0", "invalid"), null);
  assert.equal(compareExtensionVersions("invalid", "also-invalid"), null);
});

test("isExtensionVersionAtLeast returns null when either version is invalid", () => {
  assert.equal(isExtensionVersionAtLeast("invalid", "1.2.3"), null);
  assert.equal(isExtensionVersionAtLeast("1.2.3", "invalid"), null);
});

test("isExtensionVersionAtLeast returns true only when current version satisfies minimum", () => {
  assert.equal(isExtensionVersionAtLeast("2.0.0", "1.9.9"), true);
  assert.equal(isExtensionVersionAtLeast("1.2.3", "1.2.3"), true);
  assert.equal(isExtensionVersionAtLeast("1.2.2", "1.2.3"), false);
});
