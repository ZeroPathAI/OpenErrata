import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldIgnoreMetadataLessUpgradeRequiredRefresh } from "../../src/background/upgrade-required-state.js";

test("shouldIgnoreMetadataLessUpgradeRequiredRefresh ignores metadata-less refresh for active state on same API", () => {
  assert.equal(
    shouldIgnoreMetadataLessUpgradeRequiredRefresh({
      state: {
        active: true,
        message: "Update required: this API server now requires OpenErrata extension version 0.2.0 or newer.",
        apiBaseUrl: "https://api.openerrata.com",
      },
      apiBaseUrl: "https://api.openerrata.com",
      minimumSupportedExtensionVersion: undefined,
    }),
    true,
  );
});

test("shouldIgnoreMetadataLessUpgradeRequiredRefresh does not ignore when minimum version metadata is present", () => {
  assert.equal(
    shouldIgnoreMetadataLessUpgradeRequiredRefresh({
      state: {
        active: true,
        message: "Update required",
        apiBaseUrl: "https://api.openerrata.com",
      },
      apiBaseUrl: "https://api.openerrata.com",
      minimumSupportedExtensionVersion: "0.2.1",
    }),
    false,
  );
});

test("shouldIgnoreMetadataLessUpgradeRequiredRefresh does not ignore when state is inactive", () => {
  assert.equal(
    shouldIgnoreMetadataLessUpgradeRequiredRefresh({
      state: { active: false },
      apiBaseUrl: "https://api.openerrata.com",
      minimumSupportedExtensionVersion: undefined,
    }),
    false,
  );
});

test("shouldIgnoreMetadataLessUpgradeRequiredRefresh does not ignore when API base URL changed", () => {
  assert.equal(
    shouldIgnoreMetadataLessUpgradeRequiredRefresh({
      state: {
        active: true,
        message: "Update required",
        apiBaseUrl: "https://api.openerrata.com",
      },
      apiBaseUrl: "https://custom.example.com",
      minimumSupportedExtensionVersion: undefined,
    }),
    false,
  );
});
