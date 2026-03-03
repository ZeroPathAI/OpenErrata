import assert from "node:assert/strict";
import { test } from "node:test";
import { InvestigatorIncompleteResponseError } from "../../src/lib/investigators/openai-claim-validator.js";

/**
 * Invariants under test:
 *
 * 1. **InvestigatorIncompleteResponseError carries diagnostic metadata**: The
 *    orchestrator uses responseStatus, responseId, incompleteReason, and
 *    outputTextLength to classify failures as transient vs. terminal. If any
 *    of these are silently dropped, the retry logic makes wrong decisions.
 *
 * 2. **Error message is grep-able**: Operator log triage needs all four
 *    diagnostic fields in the message string. Null fields must render as
 *    "unknown", not crash the constructor.
 *
 * validateClaim itself calls OpenAI and is tested end-to-end in the
 * integration suite.
 */

test("InvestigatorIncompleteResponseError stores all diagnostic fields", () => {
  const error = new InvestigatorIncompleteResponseError({
    responseStatus: "incomplete",
    responseId: "resp_abc123",
    incompleteReason: "max_output_tokens",
    outputTextLength: 1024,
  });

  assert.equal(error.responseStatus, "incomplete");
  assert.equal(error.responseId, "resp_abc123");
  assert.equal(error.incompleteReason, "max_output_tokens");
  assert.equal(error.outputTextLength, 1024);
});

test("InvestigatorIncompleteResponseError message contains all diagnostic fields", () => {
  const error = new InvestigatorIncompleteResponseError({
    responseStatus: "incomplete",
    responseId: "resp_abc123",
    incompleteReason: "max_output_tokens",
    outputTextLength: 512,
  });

  assert.match(error.message, /incomplete/);
  assert.match(error.message, /resp_abc123/);
  assert.match(error.message, /max_output_tokens/);
  assert.match(error.message, /512/);
});

test("InvestigatorIncompleteResponseError renders null fields as 'unknown'", () => {
  const error = new InvestigatorIncompleteResponseError({
    responseStatus: null,
    responseId: null,
    incompleteReason: null,
    outputTextLength: 0,
  });

  // Must not crash, and the message must be informative for log grep.
  assert.match(error.message, /unknown/);
  assert.equal(error.name, "InvestigatorIncompleteResponseError");
});
