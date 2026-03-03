import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractPendingFunctionToolCalls,
  deduplicateFunctionToolCalls,
  buildRetainCorrectionToolDefinition,
  isClaimToolCall,
  SUBMIT_CORRECTION_TOOL_NAME,
  RETAIN_CORRECTION_TOOL_NAME,
  type PendingFunctionToolCall,
} from "../../src/lib/investigators/openai-tool-dispatch.js";

test("extractPendingFunctionToolCalls extracts valid function calls", () => {
  const record = {
    output: [
      { type: "message", id: "msg-1", status: "completed" },
      {
        type: "function_call",
        call_id: "call-1",
        name: "fetch_url",
        arguments: '{"url":"https://example.com"}',
      },
    ],
  };
  const calls = extractPendingFunctionToolCalls(record);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]);
  assert.equal(calls[0].callId, "call-1");
  assert.equal(calls[0].name, "fetch_url");
  assert.equal(calls[0].argumentsJson, '{"url":"https://example.com"}');
});

test("extractPendingFunctionToolCalls skips non-function_call items", () => {
  const record = {
    output: [{ type: "message", id: "msg-1", status: "completed" }, { type: "reasoning" }],
  };
  const calls = extractPendingFunctionToolCalls(record);
  assert.equal(calls.length, 0);
});

test("extractPendingFunctionToolCalls skips entries missing required fields", () => {
  const record = {
    output: [
      { type: "function_call", call_id: "", name: "fetch_url", arguments: "{}" },
      { type: "function_call", call_id: "call-2", name: "", arguments: "{}" },
      { type: "function_call", call_id: "call-3", name: "fetch_url", arguments: null },
    ],
  };
  const calls = extractPendingFunctionToolCalls(record);
  assert.equal(calls.length, 0);
});

test("extractPendingFunctionToolCalls handles missing output", () => {
  assert.deepStrictEqual(extractPendingFunctionToolCalls({}), []);
});

test("extractPendingFunctionToolCalls handles non-array output", () => {
  assert.deepStrictEqual(extractPendingFunctionToolCalls({ output: "not-array" }), []);
});

test("deduplicateFunctionToolCalls removes duplicate callIds", () => {
  const calls: PendingFunctionToolCall[] = [
    { callId: "call-1", name: "fetch_url", argumentsJson: '{"url":"a"}' },
    { callId: "call-1", name: "fetch_url", argumentsJson: '{"url":"b"}' },
    { callId: "call-2", name: "fetch_url", argumentsJson: '{"url":"c"}' },
  ];
  const result = deduplicateFunctionToolCalls(calls);
  assert.equal(result.length, 2);
  assert.ok(result[0]);
  assert.equal(result[0].callId, "call-1");
  assert.equal(result[0].argumentsJson, '{"url":"a"}');
  assert.ok(result[1]);
  assert.equal(result[1].callId, "call-2");
});

test("deduplicateFunctionToolCalls handles empty array", () => {
  assert.deepStrictEqual(deduplicateFunctionToolCalls([]), []);
});

// --- isClaimToolCall ---

test("isClaimToolCall distinguishes claim tools from research tools", () => {
  // Claim tools → true (these get routed to the incremental claim pipeline)
  assert.equal(
    isClaimToolCall({ callId: "c1", name: SUBMIT_CORRECTION_TOOL_NAME, argumentsJson: "{}" }),
    true,
  );
  assert.equal(
    isClaimToolCall({ callId: "c2", name: RETAIN_CORRECTION_TOOL_NAME, argumentsJson: "{}" }),
    true,
  );
  // Research tools → false (these get dispatched to executeFunctionToolCall)
  assert.equal(isClaimToolCall({ callId: "c3", name: "fetch_url", argumentsJson: "{}" }), false);
  assert.equal(
    isClaimToolCall({ callId: "c4", name: "web_search_preview", argumentsJson: "{}" }),
    false,
  );
});

// --- buildRetainCorrectionToolDefinition ---

test("buildRetainCorrectionToolDefinition constrains id to exactly the provided claim IDs", () => {
  const tool = buildRetainCorrectionToolDefinition(["claim-a", "claim-b", "claim-c"]);
  // The dynamic enum is the key behavior — it constrains the model to only retain existing claims
  assert.deepStrictEqual(tool.parameters.properties.id.enum, ["claim-a", "claim-b", "claim-c"]);
});

test("buildRetainCorrectionToolDefinition single-element enum still constrains correctly", () => {
  const tool = buildRetainCorrectionToolDefinition(["only-claim"]);
  assert.deepStrictEqual(tool.parameters.properties.id.enum, ["only-claim"]);
});
