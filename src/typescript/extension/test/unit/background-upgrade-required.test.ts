import assert from "node:assert/strict";
import { test } from "node:test";
import { installChromeMock } from "../helpers/chrome-mock";

const chromeState = installChromeMock({ version: "0.3.3" });
const upgradeRequired = await import("../../src/background/upgrade-required");

const STORAGE_KEY = "runtime:upgrade-required";

test("an upgrade notice is recorded for the configured API and persisted", async () => {
  let changes = 0;
  upgradeRequired.setUpgradeRequiredChangeListener(() => {
    changes += 1;
  });
  assert.deepEqual(await upgradeRequired.getUpgradeRequiredState(), { kind: "NOT_REQUIRED" });

  await upgradeRequired.markUpgradeRequired({
    apiBaseUrl: "https://api.openerrata.com",
    minimumSupportedExtensionVersion: "0.4.0",
  });
  const required = await upgradeRequired.getUpgradeRequiredState();
  assert.equal(required.kind, "REQUIRED");
  assert.match(required.kind === "REQUIRED" ? required.message : "", /0\.4\.0/);
  assert.deepEqual(chromeState.local[STORAGE_KEY], {
    message: required.kind === "REQUIRED" ? required.message : "",
    detectedForVersion: "0.3.3",
    apiBaseUrl: "https://api.openerrata.com",
  });

  // A later rejection without version metadata keeps the more specific notice.
  await upgradeRequired.markUpgradeRequired({
    apiBaseUrl: "https://api.openerrata.com",
    minimumSupportedExtensionVersion: undefined,
  });
  assert.deepEqual(await upgradeRequired.getUpgradeRequiredState(), required);

  await upgradeRequired.clearUpgradeRequired();
  assert.deepEqual(await upgradeRequired.getUpgradeRequiredState(), { kind: "NOT_REQUIRED" });
  assert.equal(STORAGE_KEY in chromeState.local, false);
  assert.equal(changes, 2);
});
