import type { Response } from "openai/resources/responses/responses";
import { FETCH_URL_TOOL_NAME, executeFetchUrlTool } from "./fetch-url-tool.js";
import { RETAIN_CORRECTION_TOOL_NAME, SUBMIT_CORRECTION_TOOL_NAME } from "./openai-claim-tools.js";

export interface PendingFunctionToolCall {
  callId: string;
  name: string;
  argumentsJson: string;
}

export interface FunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export function buildFunctionCallOutput(callId: string, output: string): FunctionCallOutput {
  return { type: "function_call_output", call_id: callId, output };
}

/** Function calls the model is waiting on, in the order it emitted them. */
export function extractFunctionToolCalls(response: Response): PendingFunctionToolCall[] {
  return response.output.flatMap((item) =>
    item.type === "function_call"
      ? [{ callId: item.call_id, name: item.name, argumentsJson: item.arguments }]
      : [],
  );
}

interface FunctionCallHandlers {
  submitCorrection: (call: PendingFunctionToolCall) => FunctionCallOutput;
  retainCorrection: (call: PendingFunctionToolCall) => FunctionCallOutput;
  /** Any other function tool (research tools such as fetch_url). */
  research: (call: PendingFunctionToolCall) => Promise<FunctionCallOutput>;
}

/**
 * Answers every call of a round. Claim tool calls are handled synchronously in
 * emission order (which fixes claim submission order); research calls run
 * concurrently.
 */
export async function dispatchFunctionToolCalls(
  calls: readonly PendingFunctionToolCall[],
  handlers: FunctionCallHandlers,
): Promise<FunctionCallOutput[]> {
  return Promise.all(
    // The async callback runs synchronously up to its first await, so the
    // claim handlers still run one after another in emission order.
    calls.map(async (call) => {
      switch (call.name) {
        case SUBMIT_CORRECTION_TOOL_NAME:
          return handlers.submitCorrection(call);
        case RETAIN_CORRECTION_TOOL_NAME:
          return handlers.retainCorrection(call);
        default:
          return handlers.research(call);
      }
    }),
  );
}

export async function executeFunctionToolCall(
  call: PendingFunctionToolCall,
  signal: AbortSignal,
): Promise<FunctionCallOutput> {
  signal.throwIfAborted();
  if (call.name === FETCH_URL_TOOL_NAME) {
    const toolOutput = await executeFetchUrlTool(call.argumentsJson, signal);
    return buildFunctionCallOutput(call.callId, JSON.stringify(toolOutput));
  }

  return buildFunctionCallOutput(
    call.callId,
    JSON.stringify({ ok: false, error: `Unknown function tool: ${call.name}` }),
  );
}
