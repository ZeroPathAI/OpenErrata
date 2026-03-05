import type { InvestigatorAttemptAudit, InvestigatorResponseAudit } from "./interface.js";
import { parseInvestigatorAttemptAudit } from "./interface.js";
import { buildTwoStepRequestInputAudit } from "./openai-input-builder.js";
import {
  buildErrorAudit,
  extractRequestedTools,
  mergeResponseAudits,
  offsetResponseAuditIndices,
} from "./openai-response-audit.js";
import { INVESTIGATION_VALIDATION_SYSTEM_PROMPT } from "./prompt.js";

type AttemptAuditBase = Omit<InvestigatorAttemptAudit, "response" | "error">;

interface RequestReasoning {
  effort: "low" | "medium" | "high";
  summary: "auto" | "concise" | "detailed";
}

export function createStageOneAttemptAuditBase(input: {
  startedAt: string;
  openAiModelId: string;
  systemPrompt: string;
  userPrompt: string;
  requestReasoning: RequestReasoning;
  requestedTools: unknown;
}): AttemptAuditBase {
  return {
    startedAt: input.startedAt,
    completedAt: null,
    requestModel: input.openAiModelId,
    requestInstructions: input.systemPrompt,
    requestInput: input.userPrompt,
    requestReasoningEffort: input.requestReasoning.effort,
    requestReasoningSummary: input.requestReasoning.summary,
    requestedTools: extractRequestedTools(input.requestedTools),
  };
}

export function createStageTwoAttemptAuditBase(input: {
  stageOneBase: AttemptAuditBase;
  userPrompt: string;
  validationInputSummary: string;
}): AttemptAuditBase {
  return {
    ...input.stageOneBase,
    requestInstructions:
      `=== Stage 1: Fact-check instructions ===\n${input.stageOneBase.requestInstructions}` +
      `\n\n=== Stage 2: Validation instructions ===\n${INVESTIGATION_VALIDATION_SYSTEM_PROMPT}`,
    requestInput: buildTwoStepRequestInputAudit(input.userPrompt, input.validationInputSummary),
  };
}

export function buildFailedAttemptAudit(input: {
  base: AttemptAuditBase;
  response: InvestigatorResponseAudit | null;
  error: unknown;
  completedAt?: string;
}): InvestigatorAttemptAudit {
  return parseInvestigatorAttemptAudit({
    ...input.base,
    completedAt: input.completedAt ?? new Date().toISOString(),
    response: input.response,
    error: buildErrorAudit(input.error),
  });
}

export function buildSuccessfulAttemptAudit(input: {
  base: AttemptAuditBase;
  response: InvestigatorResponseAudit;
  completedAt?: string;
}): InvestigatorAttemptAudit {
  return parseInvestigatorAttemptAudit({
    ...input.base,
    completedAt: input.completedAt ?? new Date().toISOString(),
    response: input.response,
    error: null,
  });
}

export function buildFullAttemptResponseAudit(input: {
  factCheckResponseAudit: InvestigatorResponseAudit;
  successfulValidationResponseAudits: readonly InvestigatorResponseAudit[];
  failedValidationResponseAudits: readonly InvestigatorResponseAudit[];
}): InvestigatorResponseAudit {
  let validationOutputOffset = input.factCheckResponseAudit.outputItems.length;

  const orderedValidationResponseAudits = [
    ...input.successfulValidationResponseAudits,
    ...input.failedValidationResponseAudits,
  ].map((responseAudit) => {
    const offsetAudit = offsetResponseAuditIndices(responseAudit, validationOutputOffset);
    validationOutputOffset += responseAudit.outputItems.length;
    return offsetAudit;
  });

  return mergeResponseAudits([input.factCheckResponseAudit, ...orderedValidationResponseAudits]);
}
