import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXTENSION_MESSAGE_PROTOCOL_VERSION,
  extensionRuntimeErrorResponseSchema,
} from "@openerrata/shared";
import { handleContentControlMessage } from "../../src/content/control-message-handler.js";

test("handleContentControlMessage routes FOCUS_CLAIM to controller", async () => {
  const calls: string[] = [];
  const controller = {
    requestInvestigation: () => ({ ok: true }),
    showAnnotations: () => ({ visible: true }),
    hideAnnotations: () => ({ visible: false }),
    getAnnotationVisibility: () => ({ visible: true }),
    focusClaim: (claimId: string) => {
      calls.push(claimId);
      return { ok: true };
    },
  };

  const response = handleContentControlMessage(controller, {
    v: EXTENSION_MESSAGE_PROTOCOL_VERSION,
    type: "FOCUS_CLAIM",
    payload: { claimId: "claim-123" },
  });

  assert.notEqual(response, false);
  assert.deepEqual(await response, { ok: true });
  assert.deepEqual(calls, ["claim-123"]);
});

test("handleContentControlMessage rejects invalid control payloads", () => {
  const controller = {
    requestInvestigation: () => ({ ok: true }),
    showAnnotations: () => ({ visible: true }),
    hideAnnotations: () => ({ visible: false }),
    getAnnotationVisibility: () => ({ visible: true }),
    focusClaim: (_claimId: string) => ({
      ok: true,
    }),
  };

  const response = handleContentControlMessage(controller, {
    v: EXTENSION_MESSAGE_PROTOCOL_VERSION,
    type: "FOCUS_CLAIM",
    payload: { claimId: "" },
  });

  assert.equal(response, false);
});

test("handleContentControlMessage returns unsupported protocol runtime error", async () => {
  const controller = {
    requestInvestigation: () => ({ ok: true }),
    showAnnotations: () => ({ visible: true }),
    hideAnnotations: () => ({ visible: false }),
    getAnnotationVisibility: () => ({ visible: true }),
    focusClaim: (_claimId: string) => ({
      ok: true,
    }),
  };

  const response = handleContentControlMessage(controller, {
    v: EXTENSION_MESSAGE_PROTOCOL_VERSION + 1,
    type: "GET_ANNOTATION_VISIBILITY",
  });

  assert.notEqual(response, false);
  assert.deepEqual(extensionRuntimeErrorResponseSchema.parse(await response), {
    ok: false,
    error: `Unsupported extension message protocol version: expected ${EXTENSION_MESSAGE_PROTOCOL_VERSION}, received ${EXTENSION_MESSAGE_PROTOCOL_VERSION + 1}`,
    errorCode: "UNSUPPORTED_PROTOCOL_VERSION",
  });
});
