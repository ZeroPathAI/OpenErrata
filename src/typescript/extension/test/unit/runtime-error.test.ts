import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExtensionRuntimeError,
  isContentMismatchRuntimeError,
  isExtensionContextInvalidatedError,
  isInvalidExtensionMessageRuntimeError,
  isPayloadTooLargeRuntimeError,
} from "../../src/lib/runtime-error.js";

test("isContentMismatchRuntimeError matches ExtensionRuntimeError with CONTENT_MISMATCH code", () => {
  const mismatch = new ExtensionRuntimeError("mismatch", "CONTENT_MISMATCH");
  assert.equal(isContentMismatchRuntimeError(mismatch), true);
  assert.equal(isContentMismatchRuntimeError(new Error("mismatch")), false);
});

test("isPayloadTooLargeRuntimeError matches ExtensionRuntimeError with PAYLOAD_TOO_LARGE code", () => {
  const tooLarge = new ExtensionRuntimeError("too large", "PAYLOAD_TOO_LARGE");
  assert.equal(isPayloadTooLargeRuntimeError(tooLarge), true);
  assert.equal(isPayloadTooLargeRuntimeError(new Error("too large")), false);
});

test("isInvalidExtensionMessageRuntimeError matches ExtensionRuntimeError with INVALID_EXTENSION_MESSAGE code", () => {
  const invalidMessage = new ExtensionRuntimeError("invalid message", "INVALID_EXTENSION_MESSAGE");
  assert.equal(isInvalidExtensionMessageRuntimeError(invalidMessage), true);
  assert.equal(isInvalidExtensionMessageRuntimeError(new Error("invalid message")), false);
});

test("isExtensionContextInvalidatedError matches known runtime-disconnect messages", () => {
  assert.equal(
    isExtensionContextInvalidatedError(
      new Error("Uncaught (in promise) Error: Extension context invalidated."),
    ),
    true,
  );
  assert.equal(
    isExtensionContextInvalidatedError(
      new Error("Could not establish connection. Receiving end does not exist."),
    ),
    true,
  );
  assert.equal(
    isExtensionContextInvalidatedError(
      new Error("The message port closed before a response was received."),
    ),
    true,
  );
  assert.equal(
    isExtensionContextInvalidatedError(
      new Error("Observed content does not match canonical content"),
    ),
    false,
  );
});
