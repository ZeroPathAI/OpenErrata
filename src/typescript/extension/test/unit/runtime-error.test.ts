import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExtensionRuntimeError,
  isContentMismatchRuntimeError,
  isExtensionContextInvalidatedError,
} from "../../src/lib/runtime-error.js";

test("isContentMismatchRuntimeError matches ExtensionRuntimeError with CONTENT_MISMATCH code", () => {
  const mismatch = new ExtensionRuntimeError("mismatch", "CONTENT_MISMATCH");
  assert.equal(isContentMismatchRuntimeError(mismatch), true);
  assert.equal(isContentMismatchRuntimeError(new Error("mismatch")), false);
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
    isExtensionContextInvalidatedError(new Error("Observed content does not match canonical content")),
    false,
  );
});
