import assert from "node:assert/strict";
import { test } from "node:test";
import type OpenAI from "openai";
import {
  runToolLoop,
  ToolLoopExecutionError,
} from "../../src/lib/investigators/openai-tool-loop.js";
import type {
  FunctionCallOutput,
  PendingFunctionToolCall,
} from "../../src/lib/investigators/openai-tool-dispatch.js";

function makeFunctionCall(call: { callId: string; name: string; argumentsJson: string }) {
  return {
    type: "function_call",
    id: `fc_${call.callId}`,
    call_id: call.callId,
    name: call.name,
    arguments: call.argumentsJson,
    status: "completed",
  };
}

test("runToolLoop routes submit/retain/research calls and collects response audits", async () => {
  const routed: {
    submitted: PendingFunctionToolCall[];
    retained: PendingFunctionToolCall[];
    research: PendingFunctionToolCall[];
  } = {
    submitted: [],
    retained: [],
    research: [],
  };

  let callCount = 0;
  const client = {
    responses: {
      create: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            id: "resp-1",
            status: "completed",
            model: "test-model",
            output: [
              makeFunctionCall({
                callId: "submit-1",
                name: "submit_correction",
                argumentsJson: JSON.stringify({
                  text: "claim",
                  context: "ctx",
                  summary: "sum",
                  reasoning: "reason",
                  sources: [
                    {
                      url: "https://example.com",
                      title: "Example",
                      snippet: "Snippet",
                    },
                  ],
                }),
              }),
              makeFunctionCall({
                callId: "retain-1",
                name: "retain_correction",
                argumentsJson: JSON.stringify({ id: "old-1" }),
              }),
              makeFunctionCall({
                callId: "research-1",
                name: "fetch_url",
                argumentsJson: JSON.stringify({ url: "https://example.com" }),
              }),
            ],
            output_text: null,
            usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
          };
        }

        return {
          id: "resp-2",
          status: "completed",
          model: "test-model",
          output: [
            {
              type: "message",
              id: "msg-final",
              status: "completed",
              role: "assistant",
              content: [],
            },
          ],
          output_text: null,
          usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
        };
      },
    },
  } as unknown as OpenAI;

  const output = await runToolLoop({
    client,
    maxResponseToolRounds: 5,
    baseResponseRequest: {
      model: "test-model",
      stream: false,
      instructions: "test instructions",
      tools: [],
      reasoning: {
        effort: "medium",
        summary: "detailed",
      },
    },
    initialInput: "input",
    handleSubmittedClaims: async (calls) => {
      routed.submitted = calls;
      return [
        {
          type: "function_call_output",
          call_id: calls[0]?.callId ?? "none",
          output: '{"acknowledged":true}',
        },
      ] as FunctionCallOutput[];
    },
    handleRetainedClaims: async (calls) => {
      routed.retained = calls;
      return [
        {
          type: "function_call_output",
          call_id: calls[0]?.callId ?? "none",
          output: '{"acknowledged":true}',
        },
      ];
    },
    handleResearchCalls: async (calls) => {
      routed.research = calls;
      return [
        {
          type: "function_call_output",
          call_id: calls[0]?.callId ?? "none",
          output: '{"ok":true}',
        },
      ];
    },
  });

  assert.equal(routed.submitted.length, 1);
  assert.equal(routed.submitted[0]?.name, "submit_correction");
  assert.equal(routed.retained.length, 1);
  assert.equal(routed.retained[0]?.name, "retain_correction");
  assert.equal(routed.research.length, 1);
  assert.equal(routed.research[0]?.name, "fetch_url");
  assert.equal(output.responseAudits.length, 2);
  assert.equal(output.latestResponseRecord?.["id"], "resp-2");
});

test("runToolLoop throws ToolLoopExecutionError when tool calls have no response id", async () => {
  const client = {
    responses: {
      create: async () => ({
        id: null,
        status: "completed",
        model: "test-model",
        output: [
          makeFunctionCall({
            callId: "submit-1",
            name: "submit_correction",
            argumentsJson: "{}",
          }),
        ],
        output_text: null,
      }),
    },
  } as unknown as OpenAI;

  await assert.rejects(
    () =>
      runToolLoop({
        client,
        maxResponseToolRounds: 2,
        baseResponseRequest: {
          model: "test-model",
          stream: false,
          instructions: "test instructions",
          tools: [],
          reasoning: {
            effort: "medium",
            summary: "detailed",
          },
        },
        initialInput: "input",
        handleSubmittedClaims: async () => [],
        handleRetainedClaims: async () => [],
        handleResearchCalls: async () => [],
      }),
    (error: unknown) => {
      if (!(error instanceof ToolLoopExecutionError)) {
        return false;
      }
      assert.match(error.message, /response id/);
      assert.equal(error.responseAudits.length, 1);
      return true;
    },
  );
});
