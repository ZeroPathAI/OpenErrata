import type OpenAI from "openai";
import type { Response, Tool } from "openai/resources/responses/responses";
import type { InvestigatorRequestAudit } from "./interface.js";
import type { AuditedRequestInput } from "./openai-input-builder.js";
import {
  buildFactCheckRequestParams,
  type InvestigationRequestConfig,
} from "./openai-request-config.js";
import { auditRequest, auditResponse } from "./openai-response-audit.js";
import {
  extractFunctionToolCalls,
  type FunctionCallOutput,
  type PendingFunctionToolCall,
} from "./openai-tool-dispatch.js";

/**
 * How the stage-1 fact-check loop ended. `rounds` audits every request made,
 * including a final one that failed without a response.
 */
type ToolLoopResult =
  | {
      /** The model stopped calling function tools. */
      kind: "completed";
      rounds: InvestigatorRequestAudit[];
      finalResponse: Response;
    }
  | {
      /** The model still had function calls pending when no round was left to answer them. */
      kind: "round_limit";
      rounds: InvestigatorRequestAudit[];
    }
  | {
      /** A response ended with a status other than "completed". */
      kind: "response_not_completed";
      rounds: InvestigatorRequestAudit[];
      response: Response;
    }
  | {
      /** A provider request or a tool call threw. */
      kind: "failed";
      rounds: InvestigatorRequestAudit[];
      error: unknown;
    };

export async function runToolLoop(input: {
  client: OpenAI;
  requestConfig: InvestigationRequestConfig;
  /** At least 1. */
  maxRounds: number;
  instructions: string;
  tools: Tool[];
  initialInput: AuditedRequestInput;
  signal: AbortSignal;
  handleFunctionCalls: (calls: PendingFunctionToolCall[]) => Promise<FunctionCallOutput[]>;
}): Promise<ToolLoopResult> {
  const rounds: InvestigatorRequestAudit[] = [];
  let roundInput = input.initialInput;
  let previousResponseId: string | null = null;

  for (let round = 0; ; round += 1) {
    const subject = { kind: "FACT_CHECK_ROUND", round } as const;
    const params = buildFactCheckRequestParams(input.requestConfig, {
      instructions: input.instructions,
      tools: input.tools,
      input: roundInput.request,
      previousResponseId,
    });

    let response: Response;
    try {
      response = await input.client.responses.create(params, { signal: input.signal });
    } catch (error) {
      rounds.push(auditRequest({ subject, params, auditInput: roundInput.audit, response: null }));
      return { kind: "failed", rounds, error };
    }
    rounds.push(
      auditRequest({
        subject,
        params,
        auditInput: roundInput.audit,
        response: auditResponse(response, new Date()),
      }),
    );

    if (response.status !== "completed") {
      return { kind: "response_not_completed", rounds, response };
    }

    const calls = extractFunctionToolCalls(response);
    if (calls.length === 0) {
      return { kind: "completed", rounds, finalResponse: response };
    }
    // Answering these calls needs another round; don't run tools (or schedule
    // claim validations) whose outputs could never be sent.
    if (round + 1 >= input.maxRounds) {
      return { kind: "round_limit", rounds };
    }

    let outputs: FunctionCallOutput[];
    try {
      outputs = await input.handleFunctionCalls(calls);
    } catch (error) {
      return { kind: "failed", rounds, error };
    }
    roundInput = { request: outputs, audit: outputs.map((output) => ({ ...output })) };
    previousResponseId = response.id;
  }
}
