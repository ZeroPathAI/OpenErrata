import assert from "node:assert/strict";
import { test } from "node:test";
import { installChromeMock } from "../helpers/chrome-mock";

// Persisted by an older extension version, for the API still configured.
const chromeState = installChromeMock({ version: "0.4.0" });
chromeState.local["runtime:upgrade-required"] = {
  message: "Update required",
  detectedForVersion: "0.3.3",
  apiBaseUrl: "https://api.openerrata.com",
};
const upgradeRequired = await import("../../src/background/upgrade-required");

test("a notice recorded before the extension updated is dropped on restore", async () => {
  assert.deepEqual(await upgradeRequired.getUpgradeRequiredState(), { kind: "NOT_REQUIRED" });
  assert.equal("runtime:upgrade-required" in chromeState.local, false);
});
