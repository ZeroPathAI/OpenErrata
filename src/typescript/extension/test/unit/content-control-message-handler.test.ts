import assert from "node:assert/strict";
import { test } from "node:test";
import { handleContentControlMessage } from "../../src/content/control-message-handler.js";

test("handleContentControlMessage routes FOCUS_CLAIM to controller", async () => {
  const calls: number[] = [];
  const controller = {
    requestInvestigation: () => ({ ok: true }),
    showAnnotations: () => ({ visible: true }),
    hideAnnotations: () => ({ visible: false }),
    getAnnotationVisibility: () => ({ visible: true }),
    focusClaim: (claimIndex: number) => {
      calls.push(claimIndex);
      return { ok: true };
    },
  };

  const response = handleContentControlMessage(controller, {
    type: "FOCUS_CLAIM",
    payload: { claimIndex: 3 },
  });

  assert.notEqual(response, false);
  assert.deepEqual(await response, { ok: true });
  assert.deepEqual(calls, [3]);
});

test("handleContentControlMessage rejects invalid control payloads", () => {
  const controller = {
    requestInvestigation: () => ({ ok: true }),
    showAnnotations: () => ({ visible: true }),
    hideAnnotations: () => ({ visible: false }),
    getAnnotationVisibility: () => ({ visible: true }),
    focusClaim: (_claimIndex: number) => ({ ok: true }),
  };

  const response = handleContentControlMessage(controller, {
    type: "FOCUS_CLAIM",
    payload: { claimIndex: -1 },
  });

  assert.equal(response, false);
});
