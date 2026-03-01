import assert from "node:assert/strict";
import { test } from "node:test";
import { ZodError } from "zod";
import {
  unwrapError,
  getErrorStatus,
  formatErrorForLog,
  isNonRetryableProviderError,
} from "../../src/lib/services/orchestrator-errors.js";
import {
  InvestigatorExecutionError,
  InvestigatorStructuredOutputError,
} from "../../src/lib/investigators/openai.js";
import type { InvestigatorAttemptAudit } from "../../src/lib/investigators/interface.js";

function makeDummyAttemptAudit(): InvestigatorAttemptAudit {
  return {
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    requestModel: "test-model",
    requestInstructions: "test",
    requestInput: "test",
    requestReasoningEffort: null,
    requestReasoningSummary: null,
    requestedTools: [],
    response: null,
    error: {
      errorName: "TestError",
      errorMessage: "test error",
      statusCode: null,
    },
  };
}

// --- unwrapError ---

test("unwrapError returns cause of InvestigatorExecutionError", () => {
  const cause = new TypeError("cause");
  const error = new InvestigatorExecutionError("wrapper", makeDummyAttemptAudit(), cause);
  assert.strictEqual(unwrapError(error), cause);
});

test("unwrapError returns InvestigatorExecutionError itself when no cause", () => {
  const error = new InvestigatorExecutionError("no cause", makeDummyAttemptAudit());
  assert.strictEqual(unwrapError(error), error);
});

test("unwrapError returns plain Error directly", () => {
  const error = new Error("plain");
  assert.strictEqual(unwrapError(error), error);
});

test("unwrapError returns non-array object as record", () => {
  const obj = { status: 429, message: "rate limited" };
  const result = unwrapError(obj);
  assert.deepStrictEqual(result, obj);
});

test("unwrapError stringifies primitive values", () => {
  assert.equal(unwrapError(42), "42");
  assert.equal(unwrapError(null), "null");
  assert.equal(unwrapError(undefined), "undefined");
});

test("unwrapError stringifies arrays", () => {
  const result = unwrapError([1, 2]);
  assert.equal(result, "1,2");
});

// --- getErrorStatus ---

test("getErrorStatus returns status from error object", () => {
  const error = Object.assign(new Error("fail"), { status: 500 });
  assert.equal(getErrorStatus(error), 500);
});

test("getErrorStatus returns null for error without status", () => {
  assert.equal(getErrorStatus(new Error("no status")), null);
});

test("getErrorStatus returns null for string error", () => {
  assert.equal(getErrorStatus("just a string"), null);
});

test("getErrorStatus unwraps InvestigatorExecutionError cause", () => {
  const cause = Object.assign(new Error("api"), { status: 429 });
  const error = new InvestigatorExecutionError("wrapper", makeDummyAttemptAudit(), cause);
  assert.equal(getErrorStatus(error), 429);
});

// --- formatErrorForLog ---

test("formatErrorForLog formats Error with status", () => {
  const error = Object.assign(new Error("bad request"), { status: 400 });
  assert.equal(formatErrorForLog(error), "status=400: bad request");
});

test("formatErrorForLog formats Error without status", () => {
  const error = new Error("network error");
  assert.equal(formatErrorForLog(error), "network error");
});

test("formatErrorForLog formats string", () => {
  assert.equal(formatErrorForLog("string error"), "string error");
});

test("formatErrorForLog formats object with status", () => {
  const error = { status: 502 };
  assert.equal(formatErrorForLog(error), "status=502");
});

test("formatErrorForLog formats object without status", () => {
  const error = { foo: "bar" };
  assert.equal(formatErrorForLog(error), "unknown object error");
});

// --- isNonRetryableProviderError ---

test("isNonRetryableProviderError returns true for SyntaxError", () => {
  assert.equal(isNonRetryableProviderError(new SyntaxError("bad json")), true);
});

test("isNonRetryableProviderError returns true for ZodError", () => {
  const zodError = new ZodError([]);
  assert.equal(isNonRetryableProviderError(zodError), true);
});

test("isNonRetryableProviderError returns true for InvestigatorStructuredOutputError", () => {
  const error = new InvestigatorStructuredOutputError("bad output");
  assert.equal(isNonRetryableProviderError(error), true);
});

test("isNonRetryableProviderError returns true for 400 status", () => {
  const error = Object.assign(new Error("bad request"), { status: 400 });
  assert.equal(isNonRetryableProviderError(error), true);
});

test("isNonRetryableProviderError returns true for 401 status", () => {
  const error = Object.assign(new Error("unauthorized"), { status: 401 });
  assert.equal(isNonRetryableProviderError(error), true);
});

test("isNonRetryableProviderError returns false for 429 status (rate limit)", () => {
  const error = Object.assign(new Error("rate limited"), { status: 429 });
  assert.equal(isNonRetryableProviderError(error), false);
});

test("isNonRetryableProviderError returns false for 500 status (server error)", () => {
  const error = Object.assign(new Error("server error"), { status: 500 });
  assert.equal(isNonRetryableProviderError(error), false);
});

test("isNonRetryableProviderError returns false for plain Error without status", () => {
  assert.equal(isNonRetryableProviderError(new Error("timeout")), false);
});

test("isNonRetryableProviderError unwraps InvestigatorExecutionError", () => {
  const cause = new InvestigatorStructuredOutputError("bad output");
  const error = new InvestigatorExecutionError("wrapper", makeDummyAttemptAudit(), cause);
  assert.equal(isNonRetryableProviderError(error), true);
});
