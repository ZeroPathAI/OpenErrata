import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExtensionRuntimeError,
  hasRuntimeErrorCode,
  isExtensionContextInvalidatedError,
  isNoReceivingEndError,
} from "../../src/lib/runtime-error.js";

test("hasRuntimeErrorCode matches ExtensionRuntimeErrors by code only", () => {
  const tooLarge = new ExtensionRuntimeError("too large", "PAYLOAD_TOO_LARGE");
  assert.equal(hasRuntimeErrorCode(tooLarge, "PAYLOAD_TOO_LARGE"), true);
  assert.equal(hasRuntimeErrorCode(tooLarge, "UPGRADE_REQUIRED"), false);
  assert.equal(hasRuntimeErrorCode(new Error("too large"), "PAYLOAD_TOO_LARGE"), false);
});

test("isExtensionContextInvalidatedError only matches an invalidated extension context", () => {
  assert.equal(
    isExtensionContextInvalidatedError(
      new Error("Uncaught (in promise) Error: Extension context invalidated."),
    ),
    true,
  );
  // A background that is not listening, or a handler that never replied, are
  // faults to retry or report — not a reason for the content script to stop.
  assert.equal(
    isExtensionContextInvalidatedError(
      new Error("Could not establish connection. Receiving end does not exist."),
    ),
    false,
  );
  assert.equal(
    isExtensionContextInvalidatedError(
      new Error("The message port closed before a response was received."),
    ),
    false,
  );
});

test("isNoReceivingEndError recognizes a tab without a listener", () => {
  assert.equal(
    isNoReceivingEndError(
      new Error("Could not establish connection. Receiving end does not exist."),
    ),
    true,
  );
  assert.equal(isNoReceivingEndError(new Error("Extension context invalidated.")), false);
});
