import assert from "node:assert/strict";
import { test } from "node:test";
import { claimIdSchema } from "@openerrata/shared";
import {
  InvestigatorExecutionError,
  InvestigatorIncompleteResponseError,
  InvestigatorStructuredOutputError,
} from "../../src/lib/investigators/errors.js";
import type { InvestigatorInput } from "../../src/lib/investigators/interface.js";
import { OpenAIInvestigator } from "../../src/lib/investigators/openai.js";
import { INVESTIGATION_REQUEST_CONFIG } from "../../src/lib/investigators/openai-request-config.js";
import {
  INVESTIGATION_SYSTEM_PROMPT,
  INVESTIGATION_VALIDATION_SYSTEM_PROMPT,
} from "../../src/lib/investigators/prompt.js";
import { isNonRetryableProviderError } from "../../src/lib/services/orchestrator-errors.js";
import {
  createFakeOpenAiClient,
  isValidationRequest,
  makeClaim,
  makeFunctionCall,
  makeMessage,
  makeResponse,
  makeVerdictResponse,
  makeWebSearch,
  type FakeOpenAiReply,
  type RecordedOpenAiRequest,
} from "../helpers/fake-openai.js";

const minimalInput: InvestigatorInput = {
  contentText: "Some test content for fact-checking.",
  platform: "LESSWRONG",
  url: "https://www.lesswrong.com/posts/abc123/test-post",
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function runOptions() {
  return { signal: new AbortController().signal };
}

function createInvestigator(
  reply: (
    request: RecordedOpenAiRequest,
    index: number,
  ) => FakeOpenAiReply | Promise<FakeOpenAiReply>,
  maxToolRounds = 10,
) {
  const fake = createFakeOpenAiClient(reply);
  return {
    investigator: new OpenAIInvestigator({
      client: fake.client,
      requestConfig: INVESTIGATION_REQUEST_CONFIG,
      maxToolRounds,
    }),
    requests: fake.requests,
  };
}

/** Fact-check rounds answered from `rounds` in order; validations approve unless `approve` says otherwise. */
function scriptedReplies(input: {
  rounds: ReturnType<typeof makeResponse>[];
  approve?: (validationIndex: number) => boolean;
  validationDelayMs?: (validationIndex: number) => number;
}) {
  let roundIndex = 0;
  let validationIndex = 0;
  return async (request: RecordedOpenAiRequest): Promise<FakeOpenAiReply> => {
    if (isValidationRequest(request)) {
      const index = validationIndex;
      validationIndex += 1;
      await delay(input.validationDelayMs?.(index) ?? 0);
      return {
        kind: "response",
        response: makeVerdictResponse(
          `resp_validation_${index.toString()}`,
          input.approve?.(index) ?? true,
        ),
      };
    }
    const response = input.rounds[roundIndex];
    roundIndex += 1;
    assert.ok(response, "unexpected extra fact-check round");
    return { kind: "response", response };
  };
}

async function rejectsWithExecutionError(
  promise: Promise<unknown>,
): Promise<InvestigatorExecutionError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof InvestigatorExecutionError, `unexpected error: ${String(error)}`);
    return error;
  }
  assert.fail("expected investigate() to reject");
}

test("fact-check rounds send the gpt-6.1-sol request shape and chain previous responses", async () => {
  const { investigator, requests } = createInvestigator(
    scriptedReplies({
      rounds: [
        makeResponse({
          id: "resp_round_0",
          output: [makeFunctionCall("call-fetch", "fetch_url", { url: "not a url" })],
        }),
        makeResponse({ id: "resp_round_1", output: [makeMessage("msg_done", "Done.")] }),
      ],
    }),
  );

  await investigator.investigate(minimalInput, runOptions());

  const [firstRound, secondRound] = requests;
  assert.ok(firstRound && secondRound);
  assert.equal(firstRound.path, "/v1/responses");
  assert.equal(firstRound.body.model, "gpt-6.1-sol");
  assert.equal(firstRound.body.instructions, INVESTIGATION_SYSTEM_PROMPT);
  assert.deepEqual(firstRound.body.reasoning, { effort: "medium", summary: "detailed" });
  assert.deepEqual(firstRound.body.include, ["web_search_call.action.sources"]);
  assert.deepEqual(
    firstRound.body.tools?.map((tool) => (tool.type === "function" ? tool.name : tool.type)),
    ["web_search", "fetch_url", "submit_correction"],
  );
  assert.equal(firstRound.body.previous_response_id, undefined);
  assert.equal(firstRound.body.max_output_tokens, undefined);

  assert.equal(secondRound.body.previous_response_id, "resp_round_0");
  assert.deepEqual(secondRound.body.tools, firstRound.body.tools);
  const [fetchOutput] = Array.isArray(secondRound.body.input) ? secondRound.body.input : [];
  assert.ok(fetchOutput?.type === "function_call_output");
  assert.equal(fetchOutput.call_id, "call-fetch");
});

test("update investigations offer retain_correction limited to the prior claim ids", async () => {
  const oldClaimId = claimIdSchema.parse("claim-old-1");
  const { investigator, requests } = createInvestigator(
    scriptedReplies({
      rounds: [
        makeResponse({
          id: "resp_round_0",
          output: [makeFunctionCall("call-retain", "retain_correction", { id: oldClaimId })],
        }),
        makeResponse({ id: "resp_round_1", output: [] }),
      ],
    }),
  );

  const output = await investigator.investigate(
    { ...minimalInput, isUpdate: true, oldClaims: [{ id: oldClaimId, ...makeClaim("Old") }] },
    runOptions(),
  );

  const retainTool = requests[0]?.body.tools?.find(
    (tool) => tool.type === "function" && tool.name === "retain_correction",
  );
  assert.ok(retainTool?.type === "function");
  assert.deepEqual(retainTool.parameters?.["properties"], {
    id: {
      type: "string",
      enum: [oldClaimId],
      description: "The ID of the existing claim to retain.",
    },
  });
  assert.deepEqual(output.result.claims, [makeClaim("Old")]);
});

test("investigate returns claims in submission order regardless of validation settlement order", async () => {
  const claims = [makeClaim("Alpha"), makeClaim("Beta"), makeClaim("Gamma")];
  const { investigator } = createInvestigator(
    scriptedReplies({
      rounds: [
        makeResponse({
          id: "resp_round_0",
          output: claims.map((claim, index) =>
            makeFunctionCall(`call-${index.toString()}`, "submit_correction", claim),
          ),
        }),
        makeResponse({ id: "resp_round_1", output: [] }),
      ],
      // Settle in reverse order: claim 2 fastest, claim 0 slowest.
      validationDelayMs: (index) => [40, 20, 5][index] ?? 0,
    }),
  );

  const output = await investigator.investigate(minimalInput, runOptions());

  assert.deepEqual(output.result.claims, claims);
});

test("investigate preserves submission order when some validations reject", async () => {
  const claims = [makeClaim("Alpha"), makeClaim("Beta"), makeClaim("Gamma")];
  const { investigator } = createInvestigator(
    scriptedReplies({
      rounds: [
        makeResponse({
          id: "resp_round_0",
          output: claims.map((claim, index) =>
            makeFunctionCall(`call-${index.toString()}`, "submit_correction", claim),
          ),
        }),
        makeResponse({ id: "resp_round_1", output: [] }),
      ],
      approve: (index) => index !== 1,
      validationDelayMs: (index) => [30, 5, 15][index] ?? 0,
    }),
  );

  const output = await investigator.investigate(minimalInput, runOptions());

  assert.deepEqual(output.result.claims, [claims[0], claims[2]]);
});

test("invalid claim submissions are rejected back to the model and never validated", async () => {
  const unsafeClaim = {
    ...makeClaim("Unsafe"),
    sources: [{ url: "ftp://example.com/evidence.txt", title: "Source", snippet: "Snippet" }],
  };
  const { investigator, requests } = createInvestigator(
    scriptedReplies({
      rounds: [
        makeResponse({
          id: "resp_round_0",
          output: [makeFunctionCall("call-unsafe", "submit_correction", unsafeClaim)],
        }),
        makeResponse({ id: "resp_round_1", output: [] }),
      ],
    }),
  );

  const output = await investigator.investigate(minimalInput, runOptions());

  assert.deepEqual(output.result.claims, []);
  assert.equal(requests.filter(isValidationRequest).length, 0);
  const [rejection] = Array.isArray(requests[1]?.body.input) ? requests[1].body.input : [];
  assert.ok(rejection?.type === "function_call_output");
  assert.equal(rejection.call_id, "call-unsafe");
  assert.equal(typeof rejection.output, "string");
  assert.match(rejection.output as string, /Invalid claim, not recorded/);
});

test("the attempt audit records every provider request, with model and modelVersion from stage 1", async () => {
  const { investigator } = createInvestigator(
    scriptedReplies({
      rounds: [
        makeResponse({
          id: "resp_round_0",
          model: "gpt-6.1-sol-2026-09-01",
          output: [
            makeWebSearch("ws_1", "moon distance", ["https://nasa.gov/moon"]),
            makeFunctionCall("call-0", "submit_correction", makeClaim("Alpha")),
          ],
        }),
        makeResponse({ id: "resp_round_1", model: "gpt-6.1-sol-2026-09-01", output: [] }),
      ],
    }),
  );

  const output = await investigator.investigate(minimalInput, runOptions());

  assert.equal(output.model, "gpt-6.1-sol");
  assert.equal(output.modelVersion, "gpt-6.1-sol-2026-09-01");
  assert.equal(output.attemptAudit.outcome, "SUCCEEDED");
  assert.deepEqual(
    output.attemptAudit.requests.map((request) => request.subject),
    [
      { kind: "FACT_CHECK_ROUND", round: 0 },
      { kind: "FACT_CHECK_ROUND", round: 1 },
      { kind: "CLAIM_VALIDATION", claimIndex: 0 },
    ],
  );
  const [round0, round1, validation] = output.attemptAudit.requests;
  assert.ok(round0 && round1 && validation);
  assert.equal(typeof round0.input, "string");
  assert.match(round0.input as string, /Some test content for fact-checking\./);
  assert.equal(round0.previousResponseId, null);
  assert.equal(round1.previousResponseId, "resp_round_0");
  assert.deepEqual(round0.include, ["web_search_call.action.sources"]);
  assert.equal(round0.response?.outputItems[0]?.content.kind, "TOOL_CALL");
  assert.equal(validation.instructions, INVESTIGATION_VALIDATION_SYSTEM_PROMPT);
  assert.equal(typeof validation.input, "string");
  assert.match(validation.input as string, /Incorrect claim: Alpha/);
  assert.deepEqual(validation.tools, []);
  assert.equal(validation.response?.providerResponseId, "resp_validation_0");
});

test("the round limit fails the attempt without running the last round's tool calls", async () => {
  const { investigator, requests } = createInvestigator(
    scriptedReplies({
      rounds: [
        makeResponse({
          id: "resp_round_0",
          output: [makeFunctionCall("call-0", "submit_correction", makeClaim("Alpha"))],
        }),
        makeResponse({
          id: "resp_round_1",
          output: [makeFunctionCall("call-1", "submit_correction", makeClaim("Beta"))],
        }),
      ],
    }),
    2,
  );

  const error = await rejectsWithExecutionError(
    investigator.investigate(minimalInput, runOptions()),
  );

  assert.ok(error.cause instanceof InvestigatorStructuredOutputError);
  assert.match(error.cause.message, /round limit \(2\)/);
  assert.equal(isNonRetryableProviderError(error), true);
  // Only the first round's claim was validated; the second was never acknowledged.
  assert.equal(requests.filter(isValidationRequest).length, 1);
  assert.deepEqual(
    error.attemptAudit.requests.map((request) => request.subject.kind),
    ["FACT_CHECK_ROUND", "FACT_CHECK_ROUND", "CLAIM_VALIDATION"],
  );
  assert.equal(error.attemptAudit.outcome, "FAILED");
});

test("an incomplete fact-check response fails the attempt non-retryably", async () => {
  const { investigator } = createInvestigator(
    scriptedReplies({
      rounds: [
        makeResponse({
          id: "resp_round_0",
          status: "incomplete",
          incompleteReason: "max_output_tokens",
          output: [makeMessage("msg_partial", "Partial")],
        }),
      ],
    }),
  );

  const error = await rejectsWithExecutionError(
    investigator.investigate(minimalInput, runOptions()),
  );

  assert.ok(error.cause instanceof InvestigatorIncompleteResponseError);
  assert.equal(error.cause.responseStatus, "incomplete");
  assert.equal(error.cause.incompleteReason, "max_output_tokens");
  assert.equal(isNonRetryableProviderError(error), true);
  assert.equal(error.attemptAudit.error.errorName, "InvestigatorIncompleteResponseError");
  assert.equal(error.attemptAudit.requests[0]?.response?.status, "incomplete");
});

test("a failed validation fails the attempt after recording every request", async () => {
  const { investigator } = createInvestigator(async (request) => {
    if (isValidationRequest(request)) {
      return { kind: "http_error", status: 500, message: "upstream failure" };
    }
    return request.body.previous_response_id === undefined
      ? {
          kind: "response",
          response: makeResponse({
            id: "resp_round_0",
            output: [makeFunctionCall("call-0", "submit_correction", makeClaim("Alpha"))],
          }),
        }
      : { kind: "response", response: makeResponse({ id: "resp_round_1", output: [] }) };
  });

  const error = await rejectsWithExecutionError(
    investigator.investigate(minimalInput, runOptions()),
  );

  assert.match(error.message, /claim indices: 0/);
  assert.equal(isNonRetryableProviderError(error), false);
  assert.equal(error.attemptAudit.error.statusCode, 500);
  const validation = error.attemptAudit.requests[2];
  assert.deepEqual(validation?.subject, { kind: "CLAIM_VALIDATION", claimIndex: 0 });
  assert.equal(validation.response, null);
});

test("an aborted run fails with the audit of the request it interrupted", async () => {
  const { investigator } = createInvestigator(() => ({ kind: "hang" }));
  const controller = new AbortController();

  const run = investigator.investigate(minimalInput, { signal: controller.signal });
  controller.abort();
  const error = await rejectsWithExecutionError(run);

  assert.equal(error.attemptAudit.requests.length, 1);
  assert.equal(error.attemptAudit.requests[0]?.response, null);
  assert.equal(error.attemptAudit.error.errorName, "APIUserAbortError");
});

test("the constructor rejects a non-positive tool round budget", () => {
  const { client } = createFakeOpenAiClient(() => ({ kind: "hang" }));
  assert.throws(
    () =>
      new OpenAIInvestigator({
        client,
        requestConfig: INVESTIGATION_REQUEST_CONFIG,
        maxToolRounds: 0,
      }),
    /maxToolRounds must be a positive integer/,
  );
});
