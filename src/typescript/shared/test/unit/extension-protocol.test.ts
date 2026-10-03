import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseBackgroundRequestPayload,
  parseBackgroundResponseEnvelope,
  parseContentRequestPayload,
  parseContentResponseEnvelope,
} from "../../src/index.js";

const TAB_SESSION_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

test("background payloads are validated against the schema registered for their type", () => {
  const reset = parseBackgroundRequestPayload("PAGE_RESET", { tabSessionId: TAB_SESSION_ID });
  assert.deepEqual(reset, { success: true, data: { tabSessionId: TAB_SESSION_ID } });

  assert.equal(parseBackgroundRequestPayload("PAGE_RESET", { tabSessionId: "7" }).success, false);
  assert.equal(
    parseBackgroundRequestPayload("GET_TAB_STATUS", { tabId: 3, extra: true }).success,
    false,
  );
});

test("background response envelopes validate the value only when ok", () => {
  const upgrade = { kind: "UPGRADE_REQUIRED", message: "Update OpenErrata" } as const;
  assert.deepEqual(
    parseBackgroundResponseEnvelope("GET_TAB_STATUS", { ok: true, value: upgrade }),
    { success: true, data: { ok: true, value: upgrade } },
  );

  const runtimeError = {
    ok: false,
    error: "Message failed validation",
    errorCode: "INVALID_EXTENSION_MESSAGE",
  } as const;
  assert.deepEqual(parseBackgroundResponseEnvelope("GET_TAB_STATUS", runtimeError), {
    success: true,
    data: runtimeError,
  });

  assert.equal(
    parseBackgroundResponseEnvelope("GET_TAB_STATUS", { ok: true, value: { kind: "STATUS" } })
      .success,
    false,
  );
  assert.equal(parseBackgroundResponseEnvelope("PAGE_RESET", undefined).success, false);
});

test("content payloads are validated against the schema registered for their type", () => {
  assert.deepEqual(parseContentRequestPayload("PING", null), { success: true, data: null });
  assert.deepEqual(parseContentRequestPayload("FOCUS_CLAIM", { claimId: "claim-1" }), {
    success: true,
    data: { claimId: "claim-1" },
  });

  assert.equal(parseContentRequestPayload("PING", {}).success, false);
  assert.equal(parseContentRequestPayload("FOCUS_CLAIM", { claimId: "" }).success, false);
});

test("content response envelopes validate the value only when ok", () => {
  assert.deepEqual(parseContentResponseEnvelope("PING", { ok: true, value: { alive: true } }), {
    success: true,
    data: { ok: true, value: { alive: true } },
  });

  const runtimeError = { ok: false, error: "No page session" } as const;
  assert.deepEqual(parseContentResponseEnvelope("REQUEST_INVESTIGATE", runtimeError), {
    success: true,
    data: runtimeError,
  });

  assert.equal(
    parseContentResponseEnvelope("GET_VISIBILITY", { ok: true, value: { visible: "yes" } }).success,
    false,
  );
  // A bare value without an envelope is a protocol violation, not a success.
  assert.equal(parseContentResponseEnvelope("PING", { alive: true }).success, false);
});
