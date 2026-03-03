import { isNonNullObject } from "@openerrata/shared";
import { FETCH_URL_TOOL_NAME, executeFetchUrlTool } from "./fetch-url-tool.js";
import { readString } from "./openai-response-audit.js";

const isRecord = isNonNullObject;

export const SUBMIT_CORRECTION_TOOL_NAME = "submit_correction";
export const RETAIN_CORRECTION_TOOL_NAME = "retain_correction";

/**
 * OpenAI function tool definition for submitting an individual claim.
 * The model calls this as it discovers each correction during investigation.
 *
 * Uses `strict: true` to enable structured outputs for the tool parameters.
 * The JSON Schema mirrors `providerStructuredInvestigationClaimPayloadSchema`
 * from `openai-schemas.ts` but is expressed as a plain object because the
 * OpenAI SDK requires a JSON Schema object, not a Zod schema.
 */
export const submitCorrectionToolDefinition = {
  type: "function" as const,
  name: SUBMIT_CORRECTION_TOOL_NAME,
  description:
    "Submit a single factual correction you have found and verified. " +
    "Call this tool for each incorrect claim you discover — do not wait " +
    "until you have found all claims.",
  strict: true as const,
  parameters: {
    type: "object" as const,
    properties: {
      text: { type: "string" as const, description: "The exact text of the incorrect claim." },
      context: {
        type: "string" as const,
        description: "Surrounding context that disambiguates the claim location.",
      },
      summary: {
        type: "string" as const,
        description: "A one-sentence summary of what is incorrect and why.",
      },
      reasoning: {
        type: "string" as const,
        description: "Detailed reasoning with evidence for why the claim is incorrect.",
      },
      sources: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            url: { type: "string" as const, description: "Source URL (absolute http/https)." },
            title: { type: "string" as const, description: "Title of the source." },
            snippet: {
              type: "string" as const,
              description: "Relevant snippet from the source.",
            },
          },
          required: ["url", "title", "snippet"] as const,
          additionalProperties: false as const,
        },
        description: "At least one supporting source.",
      },
    },
    required: ["text", "context", "summary", "reasoning", "sources"] as const,
    additionalProperties: false as const,
  },
};

/**
 * OpenAI function tool definition for retaining an existing claim during
 * update investigations. The model calls this to carry forward a previously
 * validated claim unchanged.
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- return type is intentionally inferred; the `as const` assertions on each field provide narrow literal types
export function buildRetainCorrectionToolDefinition(oldClaimIds: [string, ...string[]]) {
  return {
    type: "function" as const,
    name: RETAIN_CORRECTION_TOOL_NAME,
    description:
      "Retain an existing claim from the previous investigation that is " +
      "still correct and relevant. Use this instead of re-submitting the " +
      "same claim via submit_correction.",
    strict: true as const,
    parameters: {
      type: "object" as const,
      properties: {
        id: {
          type: "string" as const,
          enum: oldClaimIds,
          description: "The ID of the existing claim to retain.",
        },
      },
      required: ["id"] as const,
      additionalProperties: false as const,
    },
  };
}

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

/** Returns true if the tool call is a claim submission/retain tool handled by the investigator loop. */
export function isClaimToolCall(call: PendingFunctionToolCall): boolean {
  return call.name === SUBMIT_CORRECTION_TOOL_NAME || call.name === RETAIN_CORRECTION_TOOL_NAME;
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
