import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFunctionCallOutput,
  dispatchFunctionToolCalls,
  executeFunctionToolCall,
  extractFunctionToolCalls,
  type PendingFunctionToolCall,
} from "../../src/lib/investigators/openai-tool-dispatch.js";
import {
  makeFunctionCall,
  makeMessage,
  makeReasoning,
  makeResponse,
  makeWebSearch,
} from "../helpers/fake-openai.js";

test("extractFunctionToolCalls returns function calls in emission order and nothing else", () => {
  const response = makeResponse({
    id: "resp_1",
    output: [
      makeReasoning("rs_1", []),
      makeFunctionCall("call-1", "fetch_url", { url: "https://example.com" }),
      makeWebSearch("ws_1", "query", []),
      makeMessage("msg_1", "text"),
      makeFunctionCall("call-2", "submit_correction", { text: "x" }),
    ],
  });

  assert.deepEqual(extractFunctionToolCalls(response), [
    { callId: "call-1", name: "fetch_url", argumentsJson: '{"url":"https://example.com"}' },
    { callId: "call-2", name: "submit_correction", argumentsJson: '{"text":"x"}' },
  ]);
});

test("dispatchFunctionToolCalls routes each call and answers in call order", async () => {
  const calls: PendingFunctionToolCall[] = [
    { callId: "c1", name: "fetch_url", argumentsJson: "{}" },
    { callId: "c2", name: "submit_correction", argumentsJson: "{}" },
    { callId: "c3", name: "retain_correction", argumentsJson: "{}" },
    { callId: "c4", name: "submit_correction", argumentsJson: "{}" },
  ];
  const handled: string[] = [];

  const outputs = await dispatchFunctionToolCalls(calls, {
    submitCorrection: (call) => {
      handled.push(`submit:${call.callId}`);
      return buildFunctionCallOutput(call.callId, "submitted");
    },
    retainCorrection: (call) => {
      handled.push(`retain:${call.callId}`);
      return buildFunctionCallOutput(call.callId, "retained");
    },
    research: async (call) => {
      handled.push(`research:${call.callId}`);
      return buildFunctionCallOutput(call.callId, "researched");
    },
  });

  // Claim tools are handled synchronously in emission order (submission order).
  assert.deepEqual(handled, ["research:c1", "submit:c2", "retain:c3", "submit:c4"]);
  assert.deepEqual(
    outputs.map((output) => [output.call_id, output.output]),
    [
      ["c1", "researched"],
      ["c2", "submitted"],
      ["c3", "retained"],
      ["c4", "submitted"],
    ],
  );
});

test("executeFunctionToolCall answers unknown tools with an error output", async () => {
  const output = await executeFunctionToolCall(
    { callId: "c1", name: "made_up_tool", argumentsJson: "{}" },
    new AbortController().signal,
  );
  assert.deepEqual(output, {
    type: "function_call_output",
    call_id: "c1",
    output: JSON.stringify({ ok: false, error: "Unknown function tool: made_up_tool" }),
  });
});

test("executeFunctionToolCall does not start work for an aborted run", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executeFunctionToolCall(
      { callId: "c1", name: "fetch_url", argumentsJson: '{"url":"https://example.com"}' },
      controller.signal,
    ),
    { name: "AbortError" },
  );
});
