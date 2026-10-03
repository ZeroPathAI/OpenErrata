/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import assert from "node:assert/strict";
import OpenAI from "openai";
import type {
  Response as OpenAiResponse,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseFunctionWebSearch,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
} from "openai/resources/responses/responses";
import type { InvestigatorRequestAudit } from "../../src/lib/investigators/interface.js";

/**
 * A real OpenAI SDK client whose HTTP transport is a test double: tests see
 * exactly the request bodies the SDK puts on the wire, and replies go through
 * the SDK's own response handling and error classes.
 */

export interface RecordedOpenAiRequest {
  path: string;
  /** The JSON body as sent. */
  body: ResponseCreateParamsNonStreaming;
}

export type FakeOpenAiReply =
  | { kind: "response"; response: OpenAiResponse }
  | { kind: "http_error"; status: number; message: string }
  /** Never answers; the request ends only when the SDK aborts it. */
  | { kind: "hang" };

export function createFakeOpenAiClient(
  reply: (
    request: RecordedOpenAiRequest,
    index: number,
  ) => FakeOpenAiReply | Promise<FakeOpenAiReply>,
  clientOptions: { timeoutMs?: number } = {},
) {
  const requests: RecordedOpenAiRequest[] = [];
  const client = new OpenAI({
    apiKey: "sk-test-fake-key",
    maxRetries: 0,
    ...(clientOptions.timeoutMs === undefined ? {} : { timeout: clientOptions.timeoutMs }),
    fetch: async (url, init) => {
      const requestBody = init?.body;
      if (typeof requestBody !== "string") {
        assert.fail("the SDK sends JSON string bodies");
      }
      const request: RecordedOpenAiRequest = {
        path: new URL(url instanceof Request ? url.url : url).pathname,
        body: JSON.parse(requestBody),
      };
      requests.push(request);
      const result = await reply(request, requests.length - 1);
      if (result.kind === "hang") {
        return new Promise<globalThis.Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }
      const status = result.kind === "response" ? 200 : result.status;
      const responseBody =
        result.kind === "response"
          ? result.response
          : { error: { message: result.message, type: "invalid_request_error" } };
      return new globalThis.Response(JSON.stringify(responseBody), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, requests };
}

export function makeResponse(input: {
  id: string;
  output: ResponseOutputItem[];
  status?: OpenAiResponse["status"];
  model?: string;
  incompleteReason?: "max_output_tokens" | "content_filter";
}): OpenAiResponse {
  return {
    id: input.id,
    object: "response",
    created_at: 1_760_000_000,
    model: input.model ?? "gpt-6.1-sol-2026-09-01",
    status: input.status ?? "completed",
    output: input.output,
    output_text: "",
    error: null,
    incomplete_details:
      input.incompleteReason === undefined ? null : { reason: input.incompleteReason },
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 20 },
      total_tokens: 150,
    },
  };
}

export function makeFunctionCall(
  callId: string,
  name: string,
  args: unknown,
): ResponseFunctionToolCall {
  return {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
}

export function makeMessage(id: string, text: string): ResponseOutputMessage {
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

export function makeReasoning(id: string, summaries: string[]): ResponseReasoningItem {
  return {
    type: "reasoning",
    id,
    summary: summaries.map((text) => ({ type: "summary_text", text })),
  };
}

export function makeWebSearch(
  id: string,
  query: string,
  sourceUrls: string[],
): ResponseFunctionWebSearch {
  return {
    type: "web_search_call",
    id,
    status: "completed",
    action: {
      type: "search",
      query,
      sources: sourceUrls.map((url) => ({ type: "url", url })),
    },
  };
}

export function makeVerdictResponse(id: string, approved: boolean): OpenAiResponse {
  return makeResponse({ id, output: [makeMessage(`msg_${id}`, JSON.stringify({ approved }))] });
}

export function makeClaim(label: string) {
  return {
    text: `Incorrect claim: ${label}`,
    context: `The article states ${label}`,
    summary: `${label} is wrong because of evidence`,
    reasoning: `Detailed reasoning for ${label}`,
    sources: [
      {
        url: `https://example.com/${label.toLowerCase()}`,
        title: `Source ${label}`,
        snippet: `Evidence for ${label}`,
      },
    ],
  };
}

/** Whether a recorded request is a stage-2 validation call (structured verdict, no tools). */
export function isValidationRequest(request: RecordedOpenAiRequest): boolean {
  return request.body.text !== undefined;
}

/** A validation request's audit, for tests that only need some request to carry. */
export function makeValidationRequestAudit(claimIndex: number): InvestigatorRequestAudit {
  return {
    subject: { kind: "CLAIM_VALIDATION", claimIndex },
    model: "gpt-6.1-sol",
    instructions: "validation instructions",
    input: "validation prompt",
    previousResponseId: null,
    reasoningEffort: "medium",
    reasoningSummary: "detailed",
    include: [],
    tools: [],
    response: null,
  };
}
