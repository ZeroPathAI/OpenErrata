import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
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
import {
  parseInvestigatorAttemptAudit,
  type InvestigationProgressCallbacks,
  type Investigator,
  type InvestigatorAttemptAudit,
  type InvestigatorInput,
  type InvestigatorOutput,
  type InvestigatorResponseAudit,
} from "./interface.js";
import { InvestigatorStructuredOutputError } from "./openai-errors.js";
import {
  INVESTIGATION_SYSTEM_PROMPT,
  INVESTIGATION_VALIDATION_SYSTEM_PROMPT,
  buildUserPrompt,
} from "./prompt.js";
import { providerStructuredInvestigationClaimPayloadSchema } from "./openai-schemas.js";
import {
  buildInitialInput,
  buildValidationImageContextNotes,
  buildTwoStepRequestInputAudit,
} from "./openai-input-builder.js";
import {
  extractResponseAudit,
  extractRequestedTools,
  readString,
  readIncompleteReason,
  buildErrorAudit,
  offsetResponseAuditIndices,
  mergeResponseAudits,
} from "./openai-response-audit.js";
import {
  extractPendingFunctionToolCalls,
  deduplicateFunctionToolCalls,
  executeFunctionToolCall,
  isClaimToolCall,
  submitCorrectionToolDefinition,
  buildRetainCorrectionToolDefinition,
  buildFunctionCallOutput,
  SUBMIT_CORRECTION_TOOL_NAME,
  RETAIN_CORRECTION_TOOL_NAME,
  type FunctionCallOutput,
} from "./openai-tool-dispatch.js";
import {
  validateClaim,
  InvestigatorIncompleteResponseError,
  MAX_PER_CLAIM_VALIDATION_CONCURRENCY,
  type PerClaimValidationResult,
} from "./openai-claim-validator.js";

const isRecord = isNonNullObject;

const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_REASONING_SUMMARY = "detailed";
const TWO_STEP_REQUEST_INSTRUCTIONS = `=== Stage 1: Fact-check instructions ===
${INVESTIGATION_SYSTEM_PROMPT}

=== Stage 2: Validation instructions ===
${INVESTIGATION_VALIDATION_SYSTEM_PROMPT}`;

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

/** An in-flight validation promise paired with the claim it validates. */
interface PendingValidation {
  claim: StageOneClaim;
  promise: Promise<PerClaimValidationResult>;
}

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
      instructions: INVESTIGATION_SYSTEM_PROMPT,
      tools: requestedTools,
      reasoning: requestReasoning,
    };

    const startedAt = new Date().toISOString();
    const stageOneAttemptAuditBase: Omit<InvestigatorAttemptAudit, "response" | "error"> = {
      startedAt,
      completedAt: null,
      requestModel: openAiModelId,
      requestInstructions: INVESTIGATION_SYSTEM_PROMPT,
      requestInput: userPromptResult.prompt,
      requestReasoningEffort: requestReasoning.effort,
      requestReasoningSummary: requestReasoning.summary,
      requestedTools: extractRequestedTools(requestedTools),
    };

    // ── State for tool-based claim collection ─────────────────────────
    const validationLimiter = pLimit(MAX_PER_CLAIM_VALIDATION_CONCURRENCY);
    const pendingValidations: PendingValidation[] = [];
    const settledIndices = new Set<number>();
    const confirmedClaims: StageOneClaim[] = [];
    let nextClaimIndex = 0;

    // Track the order each claim was submitted (validated or retained) so
    // we can sort confirmedClaims into a stable, deterministic order after
    // all validation promises settle. Without this, the result order depends
    // on which p-limit slot finishes first — a race condition.
    const claimSubmissionOrder = new Map<StageOneClaim, number>();
    let nextSubmissionIndex = 0;

    // For update investigations: track old claims and retained IDs.
    type OldClaim = Extract<InvestigatorInput, { isUpdate: true }>["oldClaims"][number];
    const oldClaimsById = new Map<string, OldClaim>();
    if (input.isUpdate === true) {
      for (const claim of input.oldClaims) {
        oldClaimsById.set(claim.id, claim);
      }
    }
    const retainedIds = new Set<string>();

    function getPending(): StageOneClaim[] {
      return pendingValidations.filter((_, i) => !settledIndices.has(i)).map((pv) => pv.claim);
    }

    function getConfirmed(): StageOneClaim[] {
      return [...confirmedClaims];
    }

    // ── Tool loop ─────────────────────────────────────────────────────
    // Errors thrown after validation promises have been enqueued must
    // settle those promises before propagating — otherwise the rejections
    // are unhandled and may crash the worker process.
    let outputIndexOffset = 0;
    let previousResponseId: string | null = null;
    let latestResponseRecord: Record<string, unknown> | null = null;
    let nextInput: string | ResponseInput | FunctionCallOutput[] = initialInput;
    const responseAudits: InvestigatorResponseAudit[] = [];

    async function settlePendingValidations(): Promise<void> {
      if (pendingValidations.length > 0) {
        await Promise.allSettled(pendingValidations.map((pv) => pv.promise));
      }
    }

    let round = 0;
    try {
      while (round < maxResponseToolRounds) {
        const responseRequest =
          round === 0
            ? {
                ...baseResponseRequest,
                input: nextInput,
              }
            : {
                ...baseResponseRequest,
                previous_response_id: previousResponseId,
                input: nextInput,
              };

        let response: unknown;
        try {
          response = await client.responses.create(responseRequest);
        } catch (error) {
          const failedAttemptAudit = parseInvestigatorAttemptAudit({
            ...stageOneAttemptAuditBase,
            completedAt: new Date().toISOString(),
            response: responseAudits.length > 0 ? mergeResponseAudits(responseAudits) : null,
            error: buildErrorAudit(error),
          });
          throw new InvestigatorExecutionError(
            "OpenAI Responses API request failed",
            failedAttemptAudit,
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
        if (pendingFunctionCalls.length === 0) break;

        if (previousResponseId === null || previousResponseId.length === 0) {
          const cause = new InvestigatorStructuredOutputError(
            "Tool calls were emitted without a response id",
          );
          throw new InvestigatorExecutionError(
            cause.message,
            parseInvestigatorAttemptAudit({
              ...stageOneAttemptAuditBase,
              completedAt: new Date().toISOString(),
              response: mergeResponseAudits(responseAudits),
              error: buildErrorAudit(cause),
            }),
            cause,
          );
        }

        // Separate claim tools from research tools.
        const submittedClaims = pendingFunctionCalls.filter(
          (c) => c.name === SUBMIT_CORRECTION_TOOL_NAME,
        );
        const retainedClaims = pendingFunctionCalls.filter(
          (c) => c.name === RETAIN_CORRECTION_TOOL_NAME,
        );
        const researchCalls = pendingFunctionCalls.filter((c) => !isClaimToolCall(c));

        const outputs: FunctionCallOutput[] = [];

        // Handle submit_correction: parse claim, start bounded-concurrency validation, ack.
        for (const call of submittedClaims) {
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

          claimSubmissionOrder.set(claim, nextSubmissionIndex);
          nextSubmissionIndex += 1;

          const claimIndex = nextClaimIndex;
          nextClaimIndex += 1;

          const validationPromise = validationLimiter(() =>
            validateClaim(
              client,
              openAiModelId,
              claimIndex,
              claim,
              input.contentText,
              validationImageContextNotes,
              requestReasoning,
            ),
          );

          const pvIndex = pendingValidations.length;
          validationPromise.then(
            (result) => {
              settledIndices.add(pvIndex);
              if (result.error === null && result.approved) {
                confirmedClaims.push(claim);
              }
              callbacks?.onProgressUpdate(getPending(), getConfirmed());
            },
            () => {
              settledIndices.add(pvIndex);
              callbacks?.onProgressUpdate(getPending(), getConfirmed());
            },
          );
          pendingValidations.push({ claim, promise: validationPromise });
          callbacks?.onProgressUpdate(getPending(), getConfirmed());
          outputs.push(buildFunctionCallOutput(call.callId, '{"acknowledged":true}'));
        }

        // Handle retain_correction: validate ID, add to confirmed directly.
        for (const call of retainedClaims) {
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
          const oldClaim = oldClaimsById.get(retainId);
          if (!oldClaim) {
            outputs.push(
              buildFunctionCallOutput(
                call.callId,
                JSON.stringify({ error: `Unknown claim ID: ${retainId}` }),
              ),
            );
            continue;
          }

          if (retainedIds.has(retainId)) {
            outputs.push(
              buildFunctionCallOutput(
                call.callId,
                JSON.stringify({ error: `Claim ${retainId} already retained` }),
              ),
            );
            continue;
          }

          retainedIds.add(retainId);
          const { id: _claimId, ...claimPayload } = oldClaim;
          claimSubmissionOrder.set(claimPayload, nextSubmissionIndex);
          nextSubmissionIndex += 1;
          confirmedClaims.push(claimPayload);
          callbacks?.onProgressUpdate(getPending(), getConfirmed());
          outputs.push(buildFunctionCallOutput(call.callId, '{"acknowledged":true}'));
        }

        // Dispatch web_search/fetch_url as before.
        const researchOutputs = await Promise.all(
          researchCalls.map(async (call) => executeFunctionToolCall(call)),
        );
        outputs.push(...researchOutputs);

        nextInput = outputs;
        round += 1;
      }
    } catch (error) {
      await settlePendingValidations();
      throw error;
    }

    if (!latestResponseRecord || responseAudits.length === 0) {
      const cause = new InvestigatorStructuredOutputError("Model returned no response payload");
      throw new InvestigatorExecutionError(
        cause.message,
        parseInvestigatorAttemptAudit({
          ...stageOneAttemptAuditBase,
          completedAt: new Date().toISOString(),
          response: null,
          error: buildErrorAudit(cause),
        }),
        cause,
      );
    }

    const unfinishedToolCalls = deduplicateFunctionToolCalls(
      extractPendingFunctionToolCalls(latestResponseRecord),
    );
    if (unfinishedToolCalls.length > 0) {
      await settlePendingValidations();
      const cause = new InvestigatorStructuredOutputError(
        `Model exceeded tool call round limit (${maxResponseToolRounds.toString()})`,
      );
      throw new InvestigatorExecutionError(
        cause.message,
        parseInvestigatorAttemptAudit({
          ...stageOneAttemptAuditBase,
          completedAt: new Date().toISOString(),
          response: mergeResponseAudits(responseAudits),
          error: buildErrorAudit(cause),
        }),
        cause,
      );
    }

    const factCheckResponseAudit = mergeResponseAudits(responseAudits);

    // Check for incomplete response status. Unlike the old structured-output
    // path, the model may legitimately finish with status "completed" even
    // when the last round was a text-only response (no more tool calls).
    // We only treat truly incomplete responses as errors.
    if (factCheckResponseAudit.responseStatus === null) {
      console.warn(
        `OpenAI response had null status (responseId=${factCheckResponseAudit.responseId ?? "unknown"}); treating as completed`,
      );
    }
    if (
      factCheckResponseAudit.responseStatus !== "completed" &&
      factCheckResponseAudit.responseStatus !== null
    ) {
      await settlePendingValidations();
      const incompleteReason = readIncompleteReason(latestResponseRecord);
      const cause = new InvestigatorIncompleteResponseError({
        responseStatus: factCheckResponseAudit.responseStatus,
        responseId: factCheckResponseAudit.responseId,
        incompleteReason,
        outputTextLength: factCheckResponseAudit.responseOutputText?.length ?? 0,
      });
      throw new InvestigatorExecutionError(
        "OpenAI response was incomplete",
        parseInvestigatorAttemptAudit({
          ...stageOneAttemptAuditBase,
          completedAt: new Date().toISOString(),
          response: factCheckResponseAudit,
          error: buildErrorAudit(cause),
        }),
        cause,
      );
    }

    // ── Await remaining validations ───────────────────────────────────
    const validationResults = await Promise.all(pendingValidations.map((pv) => pv.promise));

    // Sort confirmed claims into stable submission order. The .then()
    // callbacks that populate confirmedClaims fire in non-deterministic
    // settlement order; this ensures the final result is reproducible.
    confirmedClaims.sort((a, b) => {
      const orderA = claimSubmissionOrder.get(a);
      const orderB = claimSubmissionOrder.get(b);
      if (orderA === undefined || orderB === undefined) {
        throw new Error("Invariant violation: confirmed claim missing submission order");
      }
      return orderA - orderB;
    });

    const validationInputSummary = validationResults
      .map((r) => `Claim ${r.claimIndex.toString()}: ${r.approved ? "approved" : "rejected"}`)
      .join("\n");
    const stageTwoInputSummary =
      validationImageContextNotes === undefined
        ? validationInputSummary
        : `${validationInputSummary}\n\nImage context notes:\n${validationImageContextNotes}`;

    const stageTwoAttemptAuditBase: Omit<InvestigatorAttemptAudit, "response" | "error"> = {
      ...stageOneAttemptAuditBase,
      requestInstructions: TWO_STEP_REQUEST_INSTRUCTIONS,
      requestInput: buildTwoStepRequestInputAudit(userPromptResult.prompt, stageTwoInputSummary),
    };

    type FailedValidation = Extract<PerClaimValidationResult, { error: Error }>;
    type SuccessfulValidation = Extract<PerClaimValidationResult, { error: null }>;

    const failedValidations = validationResults.filter(
      (result): result is FailedValidation => result.error !== null,
    );
    const validationFailureResponseAudits = failedValidations.flatMap((result) =>
      result.responseAudit === null ? [] : [result.responseAudit],
    );
    const successfulValidations = validationResults.filter(
      (result): result is SuccessfulValidation => result.error === null,
    );

    let validationOutputOffset = factCheckResponseAudit.outputItems.length;
    const orderedValidationResponseAudits = [
      ...successfulValidations.map((result) => result.responseAudit),
      ...validationFailureResponseAudits,
    ].map((responseAudit) => {
      const offsetAudit = offsetResponseAuditIndices(responseAudit, validationOutputOffset);
      validationOutputOffset += responseAudit.outputItems.length;
      return offsetAudit;
    });

    const fullAttemptResponseAudit = mergeResponseAudits([
      factCheckResponseAudit,
      ...orderedValidationResponseAudits,
    ]);

    if (failedValidations.length > 0) {
      const firstFailure = failedValidations[0];
      if (!firstFailure?.error) {
        throw new Error("Invariant violation: failed validations must include an error");
      }

      const failedClaimIndicesLabel = failedValidations
        .map((failure) => failure.claimIndex.toString())
        .join(", ");

      throw new InvestigatorExecutionError(
        `Per-claim validation failed for claim indices: ${failedClaimIndicesLabel}`,
        parseInvestigatorAttemptAudit({
          ...stageTwoAttemptAuditBase,
          completedAt: new Date().toISOString(),
          response: fullAttemptResponseAudit,
          error: buildErrorAudit(firstFailure.error),
        }),
        firstFailure.error,
      );
    }

    // Approved claims have already been added to `confirmedClaims` by the
    // per-validation `.then()` callbacks above (which fire before `Promise.all`
    // resolves because they were attached first). No additional loop needed.

    let result: InvestigationResult;
    try {
      result = investigationResultSchema.parse({ claims: confirmedClaims });
    } catch (error) {
      throw new InvestigatorExecutionError(
        "Final investigation result failed schema validation",
        parseInvestigatorAttemptAudit({
          ...stageTwoAttemptAuditBase,
          completedAt: new Date().toISOString(),
          response: fullAttemptResponseAudit,
          error: buildErrorAudit(error),
        }),
        error,
      );
    }

    return {
      result,
      attemptAudit: parseInvestigatorAttemptAudit({
        ...stageTwoAttemptAuditBase,
        completedAt: new Date().toISOString(),
        response: fullAttemptResponseAudit,
        error: null,
      }),
      ...(fullAttemptResponseAudit.responseModelVersion != null && {
        modelVersion: fullAttemptResponseAudit.responseModelVersion,
      }),
    };
  }
}
