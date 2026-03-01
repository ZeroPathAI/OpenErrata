import { isNonNullObject } from "@openerrata/shared";
import { FETCH_URL_TOOL_NAME, executeFetchUrlTool } from "./fetch-url-tool.js";
import { readString } from "./openai-response-audit.js";

const isRecord = isNonNullObject;

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

export function extractPendingFunctionToolCalls(
  responseRecord: Record<string, unknown>,
): PendingFunctionToolCall[] {
  const outputItems = Array.isArray(responseRecord["output"]) ? responseRecord["output"] : [];

  const calls: PendingFunctionToolCall[] = [];
  for (const outputItem of outputItems) {
    if (!isRecord(outputItem) || outputItem["type"] !== "function_call") continue;

    const callId = readString(outputItem["call_id"]);
    const name = readString(outputItem["name"]);
    const argumentsJson = readString(outputItem["arguments"]);
    if (
      callId === null ||
      callId.length === 0 ||
      name === null ||
      name.length === 0 ||
      argumentsJson === null
    ) {
      continue;
    }

    calls.push({ callId, name, argumentsJson });
  }

  return calls;
}

export function deduplicateFunctionToolCalls(
  calls: PendingFunctionToolCall[],
): PendingFunctionToolCall[] {
  const deduplicated: PendingFunctionToolCall[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.callId)) continue;
    seen.add(call.callId);
    deduplicated.push(call);
  }
  return deduplicated;
}

export async function executeFunctionToolCall(
  call: PendingFunctionToolCall,
): Promise<FunctionCallOutput> {
  if (call.name === FETCH_URL_TOOL_NAME) {
    const toolOutput = await executeFetchUrlTool(call.argumentsJson);
    return {
      type: "function_call_output",
      call_id: call.callId,
      output: JSON.stringify(toolOutput),
    };
  }

  return {
    type: "function_call_output",
    call_id: call.callId,
    output: JSON.stringify({
      ok: false,
      error: `Unknown function tool: ${call.name}`,
    }),
  };
}
