import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import { ZodError } from "zod";
import {
  unwrapError,
  getErrorStatus,
  formatErrorForLog,
  isNonRetryableProviderError,
} from "../../src/lib/services/orchestrator-errors.js";
import {
  InvestigatorExecutionError,
  InvestigatorIncompleteResponseError,
  InvestigatorInputError,
  InvestigatorStructuredOutputError,
} from "../../src/lib/investigators/errors.js";
import type { InvestigatorFailedAttemptAudit } from "../../src/lib/investigators/interface.js";
import {
  ExpiredOpenAiKeySourceError,
  InvalidOpenAiKeySourceError,
} from "../../src/lib/services/user-key-source.js";

function makeFailedAttemptAudit(): InvestigatorFailedAttemptAudit {
  return {
    outcome: "FAILED",
    startedAt: new Date(),
    completedAt: new Date(),
    requests: [],
    error: {
      errorName: "TestError",
      errorMessage: "test error",
      statusCode: null,
    },
  };
}

function apiError(status: number, message: string): InstanceType<typeof OpenAI.APIError> {
  return OpenAI.APIError.generate(status, { error: { message } }, undefined, new Headers());
}

// --- unwrapError ---

test("unwrapError returns cause of InvestigatorExecutionError", () => {
  const cause = new TypeError("cause");
  const error = new InvestigatorExecutionError("wrapper", makeFailedAttemptAudit(), cause);
  assert.strictEqual(unwrapError(error), cause);
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

test("getErrorStatus returns the status of OpenAI API errors", () => {
  assert.equal(getErrorStatus(apiError(500, "fail")), 500);
});

test("getErrorStatus returns null for errors that are not OpenAI API errors", () => {
  assert.equal(getErrorStatus(new Error("no status")), null);
  assert.equal(getErrorStatus(Object.assign(new Error("lookalike"), { status: 500 })), null);
  assert.equal(getErrorStatus(new OpenAI.APIConnectionTimeoutError()), null);
});

test("getErrorStatus returns null for string error", () => {
  assert.equal(getErrorStatus("just a string"), null);
});

test("getErrorStatus unwraps InvestigatorExecutionError cause", () => {
  const error = new InvestigatorExecutionError(
    "wrapper",
    makeFailedAttemptAudit(),
    apiError(429, "api"),
  );
  assert.equal(getErrorStatus(error), 429);
});

// --- formatErrorForLog ---

test("formatErrorForLog formats Error with status", () => {
  assert.equal(formatErrorForLog(apiError(400, "bad request")), "status=400: 400 bad request");
});

test("formatErrorForLog formats Error without status", () => {
  const error = new Error("network error");
  assert.equal(formatErrorForLog(error), "network error");
});

test("formatErrorForLog formats string", () => {
  assert.equal(formatErrorForLog("string error"), "string error");
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

test("isNonRetryableProviderError returns true for request, auth and not-found statuses", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isNonRetryableProviderError(apiError(status, "rejected")), true, String(status));
  }
});

test("isNonRetryableProviderError returns false for rate limits and server errors", () => {
  for (const status of [429, 500, 503]) {
    assert.equal(isNonRetryableProviderError(apiError(status, "transient")), false, String(status));
  }
});

test("isNonRetryableProviderError treats timeouts as transient", () => {
  assert.equal(isNonRetryableProviderError(new OpenAI.APIConnectionTimeoutError()), false);
});

test("isNonRetryableProviderError returns true for incomplete responses (SPEC §3.7 PARTIAL)", () => {
  const error = new InvestigatorIncompleteResponseError({
    responseStatus: "incomplete",
    responseId: "resp_1",
    incompleteReason: "max_output_tokens",
  });
  assert.equal(isNonRetryableProviderError(error), true);
});

test("isNonRetryableProviderError returns true for investigator input contract violations", () => {
  assert.equal(isNonRetryableProviderError(new InvestigatorInputError("bad offsets")), true);
});

test("isNonRetryableProviderError returns false for plain Error without status", () => {
  assert.equal(isNonRetryableProviderError(new Error("timeout")), false);
});

test("isNonRetryableProviderError unwraps InvestigatorExecutionError", () => {
  const cause = new InvestigatorStructuredOutputError("bad output");
  const error = new InvestigatorExecutionError("wrapper", makeFailedAttemptAudit(), cause);
  assert.equal(isNonRetryableProviderError(error), true);
});

test("isNonRetryableProviderError returns true for ExpiredOpenAiKeySourceError", () => {
  const error = new ExpiredOpenAiKeySourceError("run-123");
  assert.equal(isNonRetryableProviderError(error), true);
});

test("isNonRetryableProviderError returns true for InvalidOpenAiKeySourceError", () => {
  const error = new InvalidOpenAiKeySourceError("run-456", "key revoked");
  assert.equal(isNonRetryableProviderError(error), true);
});

test("isNonRetryableProviderError detects key source errors wrapped in InvestigatorExecutionError", () => {
  const cause = new ExpiredOpenAiKeySourceError("run-789");
  const error = new InvestigatorExecutionError("wrapper", makeFailedAttemptAudit(), cause);
  assert.equal(isNonRetryableProviderError(error), true);
});
