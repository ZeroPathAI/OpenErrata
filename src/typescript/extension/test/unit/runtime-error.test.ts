import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExtensionRuntimeError,
  isExtensionContextInvalidatedError,
  isInvalidExtensionMessageRuntimeError,
  isMalformedExtensionVersionRuntimeError,
  isPayloadTooLargeRuntimeError,
  isUpgradeRequiredRuntimeError,
} from "../../src/lib/runtime-error.js";

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

test("isUpgradeRequiredRuntimeError matches ExtensionRuntimeError with UPGRADE_REQUIRED code", () => {
  const upgradeRequired = new ExtensionRuntimeError("upgrade required", "UPGRADE_REQUIRED");
  assert.equal(isUpgradeRequiredRuntimeError(upgradeRequired), true);
  assert.equal(isUpgradeRequiredRuntimeError(new Error("upgrade required")), false);
});

test("isMalformedExtensionVersionRuntimeError matches ExtensionRuntimeError with MALFORMED_EXTENSION_VERSION code", () => {
  const malformed = new ExtensionRuntimeError(
    "malformed extension version",
    "MALFORMED_EXTENSION_VERSION",
  );
  assert.equal(isMalformedExtensionVersionRuntimeError(malformed), true);
  assert.equal(
    isMalformedExtensionVersionRuntimeError(new Error("malformed extension version")),
    false,
  );
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
