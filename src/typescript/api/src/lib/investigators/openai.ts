import OpenAI from "openai";
import pLimit from "p-limit";
import {
  DEFAULT_INVESTIGATION_MODEL,
  DEFAULT_INVESTIGATION_PROVIDER,
  investigationResultSchema,
  isNonNullObject,
  type InvestigationResult,
} from "@openerrata/shared";
import { getEnv } from "$lib/config/env.js";
import { fetchUrlToolDefinition } from "./fetch-url-tool.js";
import type {
  InvestigationProgressCallbacks,
  Investigator,
  InvestigatorAttemptAudit,
  InvestigatorInput,
  InvestigatorOutput,
} from "./interface.js";
import { InvestigatorStructuredOutputError } from "./openai-errors.js";
import {
  INVESTIGATION_SYSTEM_PROMPT,
  INVESTIGATION_UPDATE_SYSTEM_PROMPT,
  buildUserPrompt,
} from "./prompt.js";
import { providerStructuredInvestigationClaimPayloadSchema } from "./openai-schemas.js";
import { buildInitialInput, buildValidationImageContextNotes } from "./openai-input-builder.js";
import { readIncompleteReason, mergeResponseAudits } from "./openai-response-audit.js";
import {
  RETAIN_CORRECTION_TOOL_NAME,
  SUBMIT_CORRECTION_TOOL_NAME,
  buildFunctionCallOutput,
  buildRetainCorrectionToolDefinition,
  deduplicateFunctionToolCalls,
  executeFunctionToolCall,
  extractPendingFunctionToolCalls,
  type FunctionCallOutput,
  type PendingFunctionToolCall,
  submitCorrectionToolDefinition,
} from "./openai-tool-dispatch.js";
import {
  InvestigatorIncompleteResponseError,
  MAX_PER_CLAIM_VALIDATION_CONCURRENCY,
  type PerClaimValidationResult,
  validateClaim,
} from "./openai-claim-validator.js";
import {
  createClaimValidationScheduler,
  type ClaimValidationScheduler,
} from "./openai-claim-validation-scheduler.js";
import {
  createInvestigationRunState,
  getConfirmedClaims,
} from "./openai-investigation-run-state.js";
import { runToolLoop, ToolLoopExecutionError } from "./openai-tool-loop.js";
import {
  buildFailedAttemptAudit,
  buildFullAttemptResponseAudit,
  buildSuccessfulAttemptAudit,
  createStageOneAttemptAuditBase,
  createStageTwoAttemptAuditBase,
} from "./openai-attempt-audit-builder.js";

const isRecord = isNonNullObject;

const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_REASONING_SUMMARY = "detailed";
export { InvestigatorStructuredOutputError } from "./openai-errors.js";

function getOpenAiModelId(): string {
  return getEnv().OPENAI_MODEL_ID;
}

function getMaxResponseToolRounds(): number {
  return getEnv().OPENAI_MAX_RESPONSE_TOOL_ROUNDS;
}

export class InvestigatorExecutionError extends Error {
  readonly attemptAudit: InvestigatorAttemptAudit;
  override readonly cause: unknown;

  constructor(message: string, attemptAudit: InvestigatorAttemptAudit, cause?: unknown) {
    super(message);
    this.name = "InvestigatorExecutionError";
    this.attemptAudit = attemptAudit;
    this.cause = cause;
  }
}

type StageOneClaim = InvestigationResult["claims"][number];

export class OpenAIInvestigator implements Investigator {
  readonly provider = DEFAULT_INVESTIGATION_PROVIDER;
  readonly model = DEFAULT_INVESTIGATION_MODEL;

  private client: OpenAI;
  private readonly overrideModelId: string | undefined;
  private readonly overrideMaxToolRounds: number | undefined;

  constructor(
    apiKey: string,
    overrides?: { client?: OpenAI; modelId?: string; maxToolRounds?: number },
  ) {
    this.client = overrides?.client ?? new OpenAI({ apiKey });
    this.overrideModelId = overrides?.modelId;
    this.overrideMaxToolRounds = overrides?.maxToolRounds;
  }

  async investigate(
    input: InvestigatorInput,
    callbacks?: InvestigationProgressCallbacks,
  ): Promise<InvestigatorOutput> {
    const openAiModelId = this.overrideModelId ?? getOpenAiModelId();
    const maxResponseToolRounds = this.overrideMaxToolRounds ?? getMaxResponseToolRounds();
    const systemPrompt =
      input.isUpdate === true ? INVESTIGATION_UPDATE_SYSTEM_PROMPT : INVESTIGATION_SYSTEM_PROMPT;
    const userPromptResult = buildUserPrompt({
      contentText: input.contentText,
      ...(input.contentMarkdown !== undefined && { contentMarkdown: input.contentMarkdown }),
      platform: input.platform,
      url: input.url,
      ...(input.authorName !== undefined && { authorName: input.authorName }),
      ...(input.postPublishedAt !== undefined && { postPublishedAt: input.postPublishedAt }),
      ...(input.hasVideo !== undefined && { hasVideo: input.hasVideo }),
      ...(input.isUpdate
        ? {
            isUpdate: true as const,
            oldClaims: input.oldClaims,
            ...(input.contentDiff !== undefined && { contentDiff: input.contentDiff }),
          }
        : {}),
    });
    const initialInput = buildInitialInput(
      userPromptResult.prompt,
      userPromptResult.contentString,
      userPromptResult.contentOffset,
      input.imageOccurrences,
      input.imagePlaceholders,
    );
    const validationImageContextNotes = buildValidationImageContextNotes(input.imageOccurrences);
    const client = this.client;

    // ── Build tool set ────────────────────────────────────────────────
    const nonEmptyOldClaimIds: [string, ...string[]] | null = (() => {
      if (input.isUpdate !== true) {
        return null;
      }
      const [firstClaim, ...remainingClaims] = input.oldClaims;
      if (firstClaim === undefined) {
        return null;
      }
      return [firstClaim.id, ...remainingClaims.map((claim) => claim.id)];
    })();

    const requestedTools = [
      { type: "web_search_preview" as const },
      fetchUrlToolDefinition,
      submitCorrectionToolDefinition,
      ...(nonEmptyOldClaimIds !== null
        ? [buildRetainCorrectionToolDefinition(nonEmptyOldClaimIds)]
        : []),
    ];

    const requestReasoning = {
      effort: DEFAULT_REASONING_EFFORT as "low" | "medium" | "high",
      summary: DEFAULT_REASONING_SUMMARY as "auto" | "concise" | "detailed",
    };

    const baseResponseRequest = {
      model: openAiModelId,
      stream: false as const,
      instructions: systemPrompt,
      tools: requestedTools,
      reasoning: requestReasoning,
    };

    const startedAt = new Date().toISOString();
    const stageOneAttemptAuditBase = createStageOneAttemptAuditBase({
      startedAt,
      openAiModelId,
      systemPrompt,
      userPrompt: userPromptResult.prompt,
      requestReasoning,
      requestedTools,
    });

    const validationLimiter = pLimit(MAX_PER_CLAIM_VALIDATION_CONCURRENCY);
    const validationScheduler: ClaimValidationScheduler = createClaimValidationScheduler({
      initialState: createInvestigationRunState(
        input.isUpdate === true ? { oldClaims: input.oldClaims } : {},
      ),
      validationLimiter,
      runValidation: (claimIndex, claim) =>
        validateClaim(
          client,
          openAiModelId,
          claimIndex,
          claim,
          input.contentText,
          validationImageContextNotes,
          requestReasoning,
        ),
      ...(callbacks === undefined ? {} : { callbacks }),
    });

    const handleSubmittedClaims = (calls: PendingFunctionToolCall[]): FunctionCallOutput[] => {
      const outputs: FunctionCallOutput[] = [];
      for (const call of calls) {
        let claim: StageOneClaim;
        try {
          claim = providerStructuredInvestigationClaimPayloadSchema.parse(
            JSON.parse(call.argumentsJson),
          );
        } catch (error) {
          console.warn(
            `Malformed ${SUBMIT_CORRECTION_TOOL_NAME} tool call (call_id=${call.callId}):`,
            error instanceof Error ? error.message : error,
          );
          outputs.push(
            buildFunctionCallOutput(
              call.callId,
              JSON.stringify({ error: "Invalid claim payload" }),
            ),
          );
          continue;
        }

        validationScheduler.scheduleClaimValidation(claim);
        outputs.push(buildFunctionCallOutput(call.callId, '{"acknowledged":true}'));
      }
      return outputs;
    };

    const handleRetainedClaims = (calls: PendingFunctionToolCall[]): FunctionCallOutput[] => {
      const outputs: FunctionCallOutput[] = [];
      for (const call of calls) {
        let retainId: string;
        try {
          const raw: unknown = JSON.parse(call.argumentsJson);
          if (!isRecord(raw) || typeof raw["id"] !== "string") {
            outputs.push(
              buildFunctionCallOutput(
                call.callId,
                JSON.stringify({ error: "Invalid retain arguments: missing id" }),
              ),
            );
            continue;
          }
          retainId = raw["id"];
        } catch (error) {
          console.warn(
            `Malformed ${RETAIN_CORRECTION_TOOL_NAME} tool call (call_id=${call.callId}):`,
            error instanceof Error ? error.message : error,
          );
          outputs.push(
            buildFunctionCallOutput(
              call.callId,
              JSON.stringify({ error: "Invalid retain arguments" }),
            ),
          );
          continue;
        }

        const retained = validationScheduler.retainClaimById(retainId);
        if (retained.kind === "error") {
          outputs.push(
            buildFunctionCallOutput(call.callId, JSON.stringify({ error: retained.errorMessage })),
          );
          continue;
        }

        outputs.push(buildFunctionCallOutput(call.callId, '{"acknowledged":true}'));
      }
      return outputs;
    };

    let loopResult: Awaited<ReturnType<typeof runToolLoop>>;
    try {
      loopResult = await runToolLoop({
        client,
        maxResponseToolRounds,
        baseResponseRequest,
        initialInput,
        handleSubmittedClaims,
        handleRetainedClaims,
        handleResearchCalls: (calls) =>
          Promise.all(calls.map((call) => executeFunctionToolCall(call))),
      });
    } catch (error) {
      await validationScheduler.settleAllValidations();

      if (error instanceof ToolLoopExecutionError) {
        const responseAuditSnapshot = [...error.responseAudits];
        const attemptAudit = buildFailedAttemptAudit({
          base: stageOneAttemptAuditBase,
          response:
            responseAuditSnapshot.length > 0 ? mergeResponseAudits(responseAuditSnapshot) : null,
          error: error.cause ?? error,
        });
        throw new InvestigatorExecutionError(error.message, attemptAudit, error.cause ?? error);
      }

      throw error;
    }

    const { latestResponseRecord, responseAudits } = loopResult;

    if (latestResponseRecord === null || responseAudits.length === 0) {
      const cause = new InvestigatorStructuredOutputError("Model returned no response payload");
      throw new InvestigatorExecutionError(
        cause.message,
        buildFailedAttemptAudit({
          base: stageOneAttemptAuditBase,
          response: null,
          error: cause,
        }),
        cause,
      );
    }

    const unfinishedToolCalls = deduplicateFunctionToolCalls(
      extractPendingFunctionToolCalls(latestResponseRecord),
    );
    if (unfinishedToolCalls.length > 0) {
      await validationScheduler.settleAllValidations();
      const cause = new InvestigatorStructuredOutputError(
        `Model exceeded tool call round limit (${maxResponseToolRounds.toString()})`,
      );
      throw new InvestigatorExecutionError(
        cause.message,
        buildFailedAttemptAudit({
          base: stageOneAttemptAuditBase,
          response: mergeResponseAudits(responseAudits),
          error: cause,
        }),
        cause,
      );
    }

    const factCheckResponseAudit = mergeResponseAudits(responseAudits);
    if (factCheckResponseAudit.responseStatus === null) {
      console.warn(
        `OpenAI response had null status (responseId=${factCheckResponseAudit.responseId ?? "unknown"}); treating as completed`,
      );
    }
    if (
      factCheckResponseAudit.responseStatus !== "completed" &&
      factCheckResponseAudit.responseStatus !== null
    ) {
      await validationScheduler.settleAllValidations();
      const incompleteReason = readIncompleteReason(latestResponseRecord);
      const cause = new InvestigatorIncompleteResponseError({
        responseStatus: factCheckResponseAudit.responseStatus,
        responseId: factCheckResponseAudit.responseId,
        incompleteReason,
        outputTextLength: factCheckResponseAudit.responseOutputText?.length ?? 0,
      });
      throw new InvestigatorExecutionError(
        "OpenAI response was incomplete",
        buildFailedAttemptAudit({
          base: stageOneAttemptAuditBase,
          response: factCheckResponseAudit,
          error: cause,
        }),
        cause,
      );
    }

    const validationResults = await validationScheduler.awaitAllValidations();
    const confirmedClaims = getConfirmedClaims(validationScheduler.getState());

    const validationInputSummary = validationResults
      .map(
        (result) =>
          `Claim ${result.claimIndex.toString()}: ${result.approved ? "approved" : "rejected"}`,
      )
      .join("\n");
    const stageTwoInputSummary =
      validationImageContextNotes === undefined
        ? validationInputSummary
        : `${validationInputSummary}\n\nImage context notes:\n${validationImageContextNotes}`;

    const stageTwoAttemptAuditBase = createStageTwoAttemptAuditBase({
      stageOneBase: stageOneAttemptAuditBase,
      userPrompt: userPromptResult.prompt,
      validationInputSummary: stageTwoInputSummary,
    });

    type FailedValidation = Extract<PerClaimValidationResult, { error: Error }>;
    type SuccessfulValidation = Extract<PerClaimValidationResult, { error: null }>;

    const failedValidations = validationResults.filter(
      (result): result is FailedValidation => result.error !== null,
    );
    const successfulValidations = validationResults.filter(
      (result): result is SuccessfulValidation => result.error === null,
    );
    const validationFailureResponseAudits = failedValidations.flatMap((result) =>
      result.responseAudit === null ? [] : [result.responseAudit],
    );

    const fullAttemptResponseAudit = buildFullAttemptResponseAudit({
      factCheckResponseAudit,
      successfulValidationResponseAudits: successfulValidations.map(
        (result) => result.responseAudit,
      ),
      failedValidationResponseAudits: validationFailureResponseAudits,
    });

    if (failedValidations.length > 0) {
      const firstFailure = failedValidations[0];
      if (!firstFailure) {
        throw new Error("Invariant violation: failed validations must include at least one item");
      }

      const failedClaimIndicesLabel = failedValidations
        .map((failure) => failure.claimIndex.toString())
        .join(", ");

      throw new InvestigatorExecutionError(
        `Per-claim validation failed for claim indices: ${failedClaimIndicesLabel}`,
        buildFailedAttemptAudit({
          base: stageTwoAttemptAuditBase,
          response: fullAttemptResponseAudit,
          error: firstFailure.error,
        }),
        firstFailure.error,
      );
    }

    let result: InvestigationResult;
    try {
      result = investigationResultSchema.parse({ claims: confirmedClaims });
    } catch (error) {
      throw new InvestigatorExecutionError(
        "Final investigation result failed schema validation",
        buildFailedAttemptAudit({
          base: stageTwoAttemptAuditBase,
          response: fullAttemptResponseAudit,
          error,
        }),
        error,
      );
    }

    return {
      result,
      attemptAudit: buildSuccessfulAttemptAudit({
        base: stageTwoAttemptAuditBase,
        response: fullAttemptResponseAudit,
      }),
      ...(fullAttemptResponseAudit.responseModelVersion != null && {
        modelVersion: fullAttemptResponseAudit.responseModelVersion,
      }),
    };
  }
}
