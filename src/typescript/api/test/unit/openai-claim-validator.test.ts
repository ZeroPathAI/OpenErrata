import assert from "node:assert/strict";
import { test } from "node:test";
import type OpenAI from "openai";
import {
  InvestigatorIncompleteResponseError,
  validateClaim,
} from "../../src/lib/investigators/openai-claim-validator.js";
import type { InvestigationResult } from "@openerrata/shared";

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
 * 3. **validateClaim routes through discriminated result paths**: Success
 *    returns approved + audit + null error; API exception returns error result;
 *    incomplete response returns error result with responseAudit preserved.
 */

function makeClaim(): InvestigationResult["claims"][number] {
  return {
    text: "The earth is flat.",
    context: "In the article the author states the earth is flat.",
    summary: "The earth is not flat.",
    reasoning: "Scientific consensus establishes the earth as an oblate spheroid.",
    sources: [{ url: "https://example.com", title: "Source", snippet: "Evidence" }],
  };
}

function makeCompletedResponse(approved: boolean): Record<string, unknown> {
  return {
    id: "resp_test_123",
    status: "completed",
    model: "gpt-4.1",
    output: [
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify({ approved }) }],
      },
    ],
    output_text: JSON.stringify({ approved }),
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    },
  };
}

function makeMockClient(responseOrError: Record<string, unknown> | Error): OpenAI {
  const responsesCreate =
    responseOrError instanceof Error
      ? () => Promise.reject(responseOrError)
      : () => Promise.resolve(responseOrError);

  return {
    responses: { create: responsesCreate },
  } as unknown as OpenAI;
}

const defaultReasoning = { effort: "low" as const, summary: "auto" as const };

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

// --- validateClaim ---

test("validateClaim returns approved=true with responseAudit when model approves", async () => {
  const client = makeMockClient(makeCompletedResponse(true));
  const result = await validateClaim(
    client,
    "gpt-4.1",
    0,
    makeClaim(),
    "Some post content.",
    undefined,
    defaultReasoning,
  );

  assert.equal(result.claimIndex, 0);
  assert.equal(result.approved, true);
  assert.equal(result.error, null);
  assert.notEqual(result.responseAudit, null);
  assert.equal(result.responseAudit.responseId, "resp_test_123");
  assert.equal(result.responseAudit.responseStatus, "completed");
});

test("validateClaim returns approved=false with responseAudit when model rejects", async () => {
  const client = makeMockClient(makeCompletedResponse(false));
  const result = await validateClaim(
    client,
    "gpt-4.1",
    3,
    makeClaim(),
    "Some post content.",
    undefined,
    defaultReasoning,
  );

  assert.equal(result.claimIndex, 3);
  assert.equal(result.approved, false);
  assert.equal(result.error, null);
  assert.notEqual(result.responseAudit, null);
});

test("validateClaim returns error result when API call throws", async () => {
  const client = makeMockClient(new Error("API rate limit exceeded"));
  const result = await validateClaim(
    client,
    "gpt-4.1",
    1,
    makeClaim(),
    "Some content.",
    undefined,
    defaultReasoning,
  );

  assert.equal(result.claimIndex, 1);
  assert.equal(result.approved, false);
  assert.notEqual(result.error, null);
  assert.ok(result.error !== null);
  assert.match(result.error.message, /API rate limit exceeded/);
  // responseAudit is null when the API call itself fails
  assert.equal(result.responseAudit, null);
});

test("validateClaim returns error result for incomplete response", async () => {
  const incompleteResponse: Record<string, unknown> = {
    id: "resp_incomplete",
    status: "incomplete",
    model: "gpt-4.1",
    output: [],
    output_text: null,
    incomplete_details: { reason: "max_output_tokens" },
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  };
  const client = makeMockClient(incompleteResponse);
  const result = await validateClaim(
    client,
    "gpt-4.1",
    2,
    makeClaim(),
    "Some content.",
    undefined,
    defaultReasoning,
  );

  assert.equal(result.claimIndex, 2);
  assert.equal(result.approved, false);
  assert.notEqual(result.error, null);
  assert.ok(result.error instanceof InvestigatorIncompleteResponseError);
  // responseAudit should still be captured even on incomplete response
  assert.notEqual(result.responseAudit, null);
  assert.equal(result.responseAudit?.responseId, "resp_incomplete");
});

test("validateClaim returns error result when output_text is invalid JSON", async () => {
  const response: Record<string, unknown> = {
    id: "resp_bad_json",
    status: "completed",
    model: "gpt-4.1",
    output: [
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "not valid json" }],
      },
    ],
    output_text: "not valid json",
    usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
  };
  const client = makeMockClient(response);
  const result = await validateClaim(
    client,
    "gpt-4.1",
    0,
    makeClaim(),
    "Some content.",
    undefined,
    defaultReasoning,
  );

  assert.equal(result.approved, false);
  assert.notEqual(result.error, null);
  // responseAudit is preserved even on JSON parse error
  assert.notEqual(result.responseAudit, null);
});

test("validateClaim captures responseAudit even when structured output is malformed JSON object", async () => {
  // Model returns valid JSON but with wrong structure — the error path must
  // still preserve the responseAudit for operator debugging
  const response: Record<string, unknown> = {
    id: "resp_bad_schema",
    status: "completed",
    model: "gpt-4.1",
    output: [
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify({ wrong_field: true }) }],
      },
    ],
    output_text: JSON.stringify({ wrong_field: true }),
    usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
  };
  const client = makeMockClient(response);
  const result = await validateClaim(
    client,
    "gpt-4.1",
    0,
    makeClaim(),
    "Some content.",
    undefined,
    defaultReasoning,
  );

  assert.equal(result.approved, false);
  assert.notEqual(result.error, null);
  // Key invariant: responseAudit is preserved for logging even when parse fails
  assert.notEqual(result.responseAudit, null);
  assert.equal(result.responseAudit?.responseId, "resp_bad_schema");
});
