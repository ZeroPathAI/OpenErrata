import assert from "node:assert/strict";
import { test } from "node:test";
import { INVESTIGATION_REQUEST_CONFIG } from "../../src/lib/investigators/openai-request-config.js";
import {
  buildFunctionCallOutput,
  type PendingFunctionToolCall,
} from "../../src/lib/investigators/openai-tool-dispatch.js";
import { runToolLoop } from "../../src/lib/investigators/openai-tool-loop.js";
import {
  createFakeOpenAiClient,
  makeFunctionCall,
  makeMessage,
  makeResponse,
  type FakeOpenAiReply,
  type RecordedOpenAiRequest,
} from "../helpers/fake-openai.js";

function runLoop(input: {
  reply: (request: RecordedOpenAiRequest, index: number) => FakeOpenAiReply;
  maxRounds: number;
  onCalls?: (calls: PendingFunctionToolCall[]) => void;
}) {
  const { client, requests } = createFakeOpenAiClient(input.reply);
  const handled: PendingFunctionToolCall[][] = [];
  const result = runToolLoop({
    client,
    requestConfig: INVESTIGATION_REQUEST_CONFIG,
    maxRounds: input.maxRounds,
    instructions: "test instructions",
    tools: [{ type: "web_search" }],
    initialInput: { request: "initial prompt", audit: "initial prompt" },
    signal: new AbortController().signal,
    handleFunctionCalls: async (calls) => {
      handled.push(calls);
      input.onCalls?.(calls);
      return calls.map((call) => buildFunctionCallOutput(call.callId, `output-${call.callId}`));
    },
  });
  return { result, requests, handled };
}

function toolCallRound(id: string, callId: string) {
  return makeResponse({ id, output: [makeFunctionCall(callId, "fetch_url", { url: "x" })] });
}

test("the loop answers function calls until the model stops calling tools", async () => {
  const { result, requests, handled } = runLoop({
    maxRounds: 5,
    reply: (_request, index) => ({
      kind: "response",
      response:
        index === 0
          ? toolCallRound("resp_0", "call-a")
          : makeResponse({ id: "resp_1", output: [makeMessage("msg", "done")] }),
    }),
  });

  const outcome = await result;
  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.finalResponse.id, "resp_1");
  assert.deepEqual(
    handled.map((calls) => calls.map((call) => call.callId)),
    [["call-a"]],
  );
  assert.equal(requests[1]?.body.previous_response_id, "resp_0");
  assert.deepEqual(requests[1].body.input, [
    { type: "function_call_output", call_id: "call-a", output: "output-call-a" },
  ]);
  assert.deepEqual(
    outcome.rounds.map((round) => [round.subject, round.previousResponseId, round.input]),
    [
      [{ kind: "FACT_CHECK_ROUND", round: 0 }, null, "initial prompt"],
      [
        { kind: "FACT_CHECK_ROUND", round: 1 },
        "resp_0",
        [{ type: "function_call_output", call_id: "call-a", output: "output-call-a" }],
      ],
    ],
  );
});

test("the loop stops at the round limit without handling the last round's calls", async () => {
  const { result, requests, handled } = runLoop({
    maxRounds: 2,
    reply: (_request, index) => ({
      kind: "response",
      response: toolCallRound(`resp_${index.toString()}`, `call-${index.toString()}`),
    }),
  });

  const outcome = await result;
  assert.equal(outcome.kind, "round_limit");
  assert.equal(requests.length, 2);
  assert.equal(outcome.rounds.length, 2);
  assert.deepEqual(
    handled.map((calls) => calls.map((call) => call.callId)),
    [["call-0"]],
  );
});

test("a response that did not complete ends the loop before its calls are handled", async () => {
  const { result, handled } = runLoop({
    maxRounds: 5,
    reply: () => ({
      kind: "response",
      response: makeResponse({
        id: "resp_0",
        status: "incomplete",
        incompleteReason: "content_filter",
        output: [makeFunctionCall("call-a", "fetch_url", {})],
      }),
    }),
  });

  const outcome = await result;
  assert.equal(outcome.kind, "response_not_completed");
  assert.equal(handled.length, 0);
});

test("a failed request ends the loop with that request audited without a response", async () => {
  const { result } = runLoop({
    maxRounds: 5,
    reply: (_request, index) =>
      index === 0
        ? { kind: "response", response: toolCallRound("resp_0", "call-a") }
        : { kind: "http_error", status: 503, message: "overloaded" },
  });

  const outcome = await result;
  assert.equal(outcome.kind, "failed");
  assert.deepEqual(
    outcome.rounds.map((round) => round.response?.providerResponseId ?? null),
    ["resp_0", null],
  );
});

test("a throwing tool handler ends the loop as failed", async () => {
  const { result } = runLoop({
    maxRounds: 5,
    reply: () => ({ kind: "response", response: toolCallRound("resp_0", "call-a") }),
    onCalls: () => {
      throw new Error("tool exploded");
    },
  });

  const outcome = await result;
  assert.equal(outcome.kind, "failed");
  assert.ok(outcome.error instanceof Error);
  assert.equal(outcome.error.message, "tool exploded");
  assert.equal(outcome.rounds.length, 1);
});
