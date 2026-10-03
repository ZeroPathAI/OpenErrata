import { zodTextFormat } from "openai/helpers/zod";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseIncludable,
  ResponseInput,
  Tool,
} from "openai/resources/responses/responses";
import type { Reasoning, ReasoningEffort } from "openai/resources/shared";
import { z } from "zod";
import { fetchUrlToolDefinition } from "./fetch-url-tool.js";
import {
  buildRetainCorrectionToolDefinition,
  submitCorrectionToolDefinition,
} from "./openai-claim-tools.js";
import { INVESTIGATION_VALIDATION_SYSTEM_PROMPT } from "./prompt.js";

/**
 * The one model OpenErrata investigates with. Model choice is a code change,
 * not configuration: every request shape below (tool types, reasoning options,
 * `include` values) is what this model accepts.
 */
export const INVESTIGATION_MODEL_ID = "gpt-6.1-sol";

type ReasoningSummary = NonNullable<Reasoning["summary"]>;
// gpt-6.1-sol accepts low | medium | high | xhigh | max; it rejects "none" and "minimal".
type InvestigationReasoningEffort = Exclude<NonNullable<ReasoningEffort>, "none" | "minimal">;

/**
 * Reasoning summaries requested on every investigation request, persisted in
 * the attempt audit (SPEC §2.12); `null` requests none. gpt-6.1-sol's model docs
 * do not mention reasoning summaries; "detailed" was verified live on
 * 2026-10-02. A rejected request parameter fails every investigation
 * non-retryably (SPEC §3.7), so verify any new value live with
 * `pnpm --filter @openerrata/api smoke:openai` before deploying it.
 */
const INVESTIGATION_REASONING_SUMMARY: ReasoningSummary | null = "detailed";

export interface InvestigationRequestConfig {
  readonly model: typeof INVESTIGATION_MODEL_ID;
  readonly reasoningEffort: InvestigationReasoningEffort;
  readonly reasoningSummary: ReasoningSummary | null;
  /** Extra response fields the fact-check requests ask the provider to return. */
  readonly include: readonly ResponseIncludable[];
}

export const INVESTIGATION_REQUEST_CONFIG: InvestigationRequestConfig = {
  model: INVESTIGATION_MODEL_ID,
  // gpt-6.1-sol's default, stated explicitly so the audit records it.
  reasoningEffort: "medium",
  reasoningSummary: INVESTIGATION_REASONING_SUMMARY,
  // Without this, web_search_call items carry no sources, and the audit would
  // miss the URLs the model consulted.
  include: ["web_search_call.action.sources"],
};

/** Request parameters for every provider request an investigation makes. */
export type InvestigationRequestParams = ResponseCreateParamsNonStreaming & {
  model: typeof INVESTIGATION_MODEL_ID;
  instructions: string;
  reasoning: Reasoning;
};

function toRequestReasoning(config: InvestigationRequestConfig): Reasoning {
  return config.reasoningSummary === null
    ? { effort: config.reasoningEffort }
    : { effort: config.reasoningEffort, summary: config.reasoningSummary };
}

/**
 * Tools offered to the stage-1 fact-check. retain_correction is offered only
 * to update investigations whose parent has claims to retain.
 */
export function buildFactCheckTools(
  retainableClaimIds: readonly [string, ...string[]] | null,
): Tool[] {
  return [
    { type: "web_search" },
    fetchUrlToolDefinition,
    submitCorrectionToolDefinition,
    ...(retainableClaimIds === null
      ? []
      : [buildRetainCorrectionToolDefinition(retainableClaimIds)]),
  ];
}

/** One round of the stage-1 fact-check tool loop. */
export function buildFactCheckRequestParams(
  config: InvestigationRequestConfig,
  request: {
    instructions: string;
    tools: Tool[];
    input: string | ResponseInput;
    /** The previous round's response, which this round's input continues. */
    previousResponseId: string | null;
  },
): InvestigationRequestParams {
  return {
    model: config.model,
    stream: false,
    instructions: request.instructions,
    input: request.input,
    tools: request.tools,
    include: [...config.include],
    reasoning: toRequestReasoning(config),
    ...(request.previousResponseId === null
      ? {}
      : { previous_response_id: request.previousResponseId }),
  };
}

export const claimValidationVerdictSchema = z
  .object({
    approved: z.boolean(),
  })
  .strict();

/** A stage-2 per-claim validation call: no tools, structured yes/no verdict. */
export function buildClaimValidationRequestParams(
  config: InvestigationRequestConfig,
  validationPrompt: string,
): InvestigationRequestParams {
  return {
    model: config.model,
    stream: false,
    instructions: INVESTIGATION_VALIDATION_SYSTEM_PROMPT,
    input: validationPrompt,
    reasoning: toRequestReasoning(config),
    text: {
      format: zodTextFormat(claimValidationVerdictSchema, "claim_validation_result"),
    },
  };
}

/**
 * A minimal request with the fact-check request's shape (model, tools,
 * include, reasoning) that forbids tool use and caps output, so the provider
 * validates the shape without running an investigation.
 */
export function buildProbeRequestParams(
  config: InvestigationRequestConfig,
): InvestigationRequestParams {
  return {
    ...buildFactCheckRequestParams(config, {
      instructions: "Reply with the single word pong.",
      tools: buildFactCheckTools(null),
      input: "ping",
      previousResponseId: null,
    }),
    tool_choice: "none",
    // The smallest cap the provider has accepted for reasoning models.
    max_output_tokens: 16,
  };
}
