import type OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { isNonNullObject } from "@openerrata/shared";
import type { InvestigatorResponseAudit } from "./interface.js";
import { InvestigatorStructuredOutputError } from "./openai-errors.js";
import {
  extractResponseAudit,
  offsetResponseAuditIndices,
  readString,
} from "./openai-response-audit.js";
import {
  deduplicateFunctionToolCalls,
  extractPendingFunctionToolCalls,
  isClaimToolCall,
  RETAIN_CORRECTION_TOOL_NAME,
  SUBMIT_CORRECTION_TOOL_NAME,
  type FunctionCallOutput,
  type PendingFunctionToolCall,
} from "./openai-tool-dispatch.js";

const isRecord = isNonNullObject;

interface RequestReasoning {
  effort: "low" | "medium" | "high";
  summary: "auto" | "concise" | "detailed";
}

type RequiredResponseInput = NonNullable<ResponseCreateParamsNonStreaming["input"]>;

interface BaseResponseRequest {
  model: NonNullable<ResponseCreateParamsNonStreaming["model"]>;
  stream: false;
  instructions: string;
  tools: NonNullable<ResponseCreateParamsNonStreaming["tools"]>;
  reasoning: RequestReasoning;
}

export class ToolLoopExecutionError extends Error {
  readonly responseAudits: readonly InvestigatorResponseAudit[];

  constructor(
    message: string,
    responseAudits: readonly InvestigatorResponseAudit[],
    cause?: unknown,
  ) {
    super(message, ...(cause !== undefined ? [{ cause }] : []));
    this.name = "ToolLoopExecutionError";
    this.responseAudits = responseAudits;
  }
}

interface ToolLoopResult {
  latestResponseRecord: Record<string, unknown> | null;
  responseAudits: InvestigatorResponseAudit[];
}

export async function runToolLoop(input: {
  client: OpenAI;
  maxResponseToolRounds: number;
  baseResponseRequest: BaseResponseRequest;
  initialInput: RequiredResponseInput;
  handleSubmittedClaims: (
    calls: PendingFunctionToolCall[],
  ) => FunctionCallOutput[] | Promise<FunctionCallOutput[]>;
  handleRetainedClaims: (
    calls: PendingFunctionToolCall[],
  ) => FunctionCallOutput[] | Promise<FunctionCallOutput[]>;
  handleResearchCalls: (
    calls: PendingFunctionToolCall[],
  ) => FunctionCallOutput[] | Promise<FunctionCallOutput[]>;
}): Promise<ToolLoopResult> {
  let outputIndexOffset = 0;
  let previousResponseId: string | null = null;
  let latestResponseRecord: Record<string, unknown> | null = null;
  let nextInput: RequiredResponseInput = input.initialInput;
  const responseAudits: InvestigatorResponseAudit[] = [];

  let round = 0;
  while (round < input.maxResponseToolRounds) {
    const responseRequest: ResponseCreateParamsNonStreaming =
      round === 0
        ? {
            ...input.baseResponseRequest,
            input: nextInput,
          }
        : {
            ...input.baseResponseRequest,
            previous_response_id: previousResponseId,
            input: nextInput,
          };

    let response: unknown;
    try {
      response = await input.client.responses.create(responseRequest);
    } catch (error) {
      throw new ToolLoopExecutionError(
        "OpenAI Responses API request failed",
        responseAudits,
        error,
      );
    }

    const responseRecord = isRecord(response) ? response : {};
    latestResponseRecord = responseRecord;
    previousResponseId = readString(responseRecord["id"]);

    const responseAudit = extractResponseAudit(responseRecord);
    responseAudits.push(offsetResponseAuditIndices(responseAudit, outputIndexOffset));
    outputIndexOffset += responseAudit.outputItems.length;

    const pendingFunctionCalls = deduplicateFunctionToolCalls(
      extractPendingFunctionToolCalls(responseRecord),
    );
    if (pendingFunctionCalls.length === 0) {
      break;
    }

    if (previousResponseId === null || previousResponseId.length === 0) {
      throw new ToolLoopExecutionError(
        "Tool calls were emitted without a response id",
        responseAudits,
        new InvestigatorStructuredOutputError("Tool calls were emitted without a response id"),
      );
    }

    const submittedClaims = pendingFunctionCalls.filter(
      (call) => call.name === SUBMIT_CORRECTION_TOOL_NAME,
    );
    const retainedClaims = pendingFunctionCalls.filter(
      (call) => call.name === RETAIN_CORRECTION_TOOL_NAME,
    );
    const researchCalls = pendingFunctionCalls.filter((call) => !isClaimToolCall(call));

    const outputs: FunctionCallOutput[] = [];
    outputs.push(...(await input.handleSubmittedClaims(submittedClaims)));
    outputs.push(...(await input.handleRetainedClaims(retainedClaims)));
    outputs.push(...(await input.handleResearchCalls(researchCalls)));

    nextInput = outputs;
    round += 1;
  }

  return {
    latestResponseRecord,
    responseAudits,
  };
}
