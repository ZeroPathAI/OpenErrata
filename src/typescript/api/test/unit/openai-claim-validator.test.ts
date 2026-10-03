import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InvestigatorIncompleteResponseError,
  InvestigatorStructuredOutputError,
} from "../../src/lib/investigators/errors.js";
import { validateClaim } from "../../src/lib/investigators/openai-claim-validator.js";
import { INVESTIGATION_REQUEST_CONFIG } from "../../src/lib/investigators/openai-request-config.js";
import { INVESTIGATION_VALIDATION_SYSTEM_PROMPT } from "../../src/lib/investigators/prompt.js";
import {
  createFakeOpenAiClient,
  makeClaim,
  makeMessage,
  makeResponse,
  makeVerdictResponse,
  type FakeOpenAiReply,
} from "../helpers/fake-openai.js";

async function validate(reply: FakeOpenAiReply) {
  const { client, requests } = createFakeOpenAiClient(() => reply);
  const result = await validateClaim({
    client,
    requestConfig: INVESTIGATION_REQUEST_CONFIG,
    claimIndex: 3,
    claim: makeClaim("Alpha"),
    contentText: "The post text.",
    imageContextNotes: undefined,
    signal: new AbortController().signal,
  });
  return { result, requests };
}

test("validateClaim sends a structured yes/no request without tools", async () => {
  const { requests } = await validate({
    kind: "response",
    response: makeVerdictResponse("resp_v", true),
  });

  const [request] = requests;
  assert.ok(request);
  assert.equal(request.body.model, "gpt-6.1-sol");
  assert.equal(request.body.instructions, INVESTIGATION_VALIDATION_SYSTEM_PROMPT);
  assert.equal(request.body.tools, undefined);
  assert.equal(request.body.text?.format?.type, "json_schema");
  assert.equal(typeof request.body.input, "string");
  assert.match(request.body.input as string, /Incorrect claim: Alpha/);
});

test("validateClaim reports approved and rejected verdicts with the request audit", async () => {
  const approved = await validate({
    kind: "response",
    response: makeVerdictResponse("resp_yes", true),
  });
  assert.equal(approved.result.kind, "approved");
  assert.deepEqual(approved.result.request.subject, { kind: "CLAIM_VALIDATION", claimIndex: 3 });
  assert.equal(approved.result.request.response?.providerResponseId, "resp_yes");

  const rejected = await validate({
    kind: "response",
    response: makeVerdictResponse("resp_no", false),
  });
  assert.equal(rejected.result.kind, "rejected");
});

test("validateClaim reports a failed request with no response audit", async () => {
  const { result } = await validate({ kind: "http_error", status: 500, message: "boom" });

  assert.equal(result.kind, "failed");
  assert.equal(result.request.response, null);
  assert.equal(result.error.message, "500 boom");
});

test("validateClaim fails on an incomplete response", async () => {
  const { result } = await validate({
    kind: "response",
    response: makeResponse({
      id: "resp_cut",
      status: "incomplete",
      incompleteReason: "max_output_tokens",
      output: [],
    }),
  });

  assert.equal(result.kind, "failed");
  assert.ok(result.error instanceof InvestigatorIncompleteResponseError);
  assert.equal(result.request.response?.status, "incomplete");
});

test("validateClaim fails when the verdict is not valid structured output", async () => {
  for (const text of ["not json", JSON.stringify({ approved: "yes" }), ""]) {
    const { result } = await validate({
      kind: "response",
      response: makeResponse({ id: "resp_bad", output: [makeMessage("msg", text)] }),
    });
    assert.equal(result.kind, "failed", text);
    assert.ok(result.error instanceof InvestigatorStructuredOutputError);
    assert.equal(result.request.response?.providerResponseId, "resp_bad");
  }
});
