import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isBackgroundMessageType,
  toInvestigationStatusSnapshot,
} from "../../src/background/message-dispatch.js";

test("isBackgroundMessageType accepts supported background message types", () => {
  assert.equal(isBackgroundMessageType("PAGE_CONTENT"), true);
  assert.equal(isBackgroundMessageType("PAGE_SKIPPED"), true);
  assert.equal(isBackgroundMessageType("PAGE_RESET"), true);
  assert.equal(isBackgroundMessageType("GET_STATUS"), true);
  assert.equal(isBackgroundMessageType("INVESTIGATE_NOW"), true);
  assert.equal(isBackgroundMessageType("GET_CACHED"), true);
});

test("isBackgroundMessageType rejects non-background message types", () => {
  assert.equal(isBackgroundMessageType("STATUS_RESPONSE"), false);
  assert.equal(isBackgroundMessageType("ANNOTATIONS"), false);
  assert.equal(isBackgroundMessageType("UNKNOWN"), false);
});

test("toInvestigationStatusSnapshot drops checkedAt and preserves status fields", () => {
  const snapshot = toInvestigationStatusSnapshot({
    checkedAt: "2026-03-03T00:00:00.000Z",
    investigationState: "INVESTIGATING",
    status: "PENDING",
    provenance: "CLIENT_FALLBACK",
    pendingClaims: [],
    confirmedClaims: [],
    priorInvestigationResult: null,
  });

  assert.deepEqual(snapshot, {
    investigationState: "INVESTIGATING",
    status: "PENDING",
    provenance: "CLIENT_FALLBACK",
    pendingClaims: [],
    confirmedClaims: [],
    priorInvestigationResult: null,
  });
});
