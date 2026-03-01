import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import { zodTextFormat } from "openai/helpers/zod";
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
import {
  providerStructuredInvestigationResultSchema,
  buildUpdateInvestigationResultSchema,
} from "./openai-schemas.js";
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
  requireCompletedOutputText,
  requireJsonObject,
  buildErrorAudit,
  offsetResponseAuditIndices,
  mergeResponseAudits,
} from "./openai-response-audit.js";
import {
  extractPendingFunctionToolCalls,
  deduplicateFunctionToolCalls,
  executeFunctionToolCall,
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

export class OpenAIInvestigator implements Investigator {
  readonly provider = DEFAULT_INVESTIGATION_PROVIDER;
  readonly model = DEFAULT_INVESTIGATION_MODEL;

  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async investigate(input: InvestigatorInput): Promise<InvestigatorOutput> {
    const openAiModelId = getOpenAiModelId();
    const maxResponseToolRounds = getMaxResponseToolRounds();
    const userPrompt = buildUserPrompt({
      contentText: input.contentText,
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
    const initialInput = buildInitialInput(userPrompt, input.contentText, input.imageOccurrences);
    const validationImageContextNotes = buildValidationImageContextNotes(input.imageOccurrences);
    const client = this.client;

    const requestedTools = [{ type: "web_search_preview" as const }, fetchUrlToolDefinition];
    const requestReasoning = {
      effort: DEFAULT_REASONING_EFFORT as "low" | "medium" | "high",
      summary: DEFAULT_REASONING_SUMMARY as "auto" | "concise" | "detailed",
    };
    const oldClaimIds: [] | [string, ...string[]] = (() => {
      if (input.isUpdate !== true) {
        return [];
      }
      const [firstClaim, ...remainingClaims] = input.oldClaims;
      if (firstClaim === undefined) {
        return [];
      }
      return [firstClaim.id, ...remainingClaims.map((claim) => claim.id)];
    })();
    const stageOneFormat = input.isUpdate
      ? zodTextFormat(
          buildUpdateInvestigationResultSchema(oldClaimIds),
          "investigation_update_result",
        )
      : zodTextFormat(providerStructuredInvestigationResultSchema, "investigation_result");

    const baseResponseRequest = {
      model: openAiModelId,
      stream: false as const,
      instructions: INVESTIGATION_SYSTEM_PROMPT,
      tools: requestedTools,
      reasoning: requestReasoning,
      text: {
        format: stageOneFormat,
      },
    };

    const startedAt = new Date().toISOString();
    const stageOneAttemptAuditBase: Omit<InvestigatorAttemptAudit, "response" | "error"> = {
      startedAt,
      completedAt: null,
      requestModel: openAiModelId,
      requestInstructions: INVESTIGATION_SYSTEM_PROMPT,
      requestInput: userPrompt,
      requestReasoningEffort: requestReasoning.effort,
      requestReasoningSummary: requestReasoning.summary,
      requestedTools: extractRequestedTools(requestedTools),
    };

    let outputIndexOffset = 0;
    let previousResponseId: string | null = null;
    let latestResponseRecord: Record<string, unknown> | null = null;
    let nextInput: string | ResponseInput | FunctionCallOutput[] = initialInput;
    const responseAudits: InvestigatorResponseAudit[] = [];

    let round = 0;
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

      nextInput = await Promise.all(
        pendingFunctionCalls.map(async (call) => executeFunctionToolCall(call)),
      );

      round += 1;
    }

    if (!latestResponseRecord || responseAudits.length === 0) {
      const cause = new InvestigatorStructuredOutputError("Model returned no response payload");
      throw new InvestigatorExecutionError(
        cause.message,
        parseInvestigatorAttemptAudit({
          ...stageOneAttemptAuditBase,
          completedAt: new Date().toISOString(),
          error: buildErrorAudit(cause),
        }),
        cause,
      );
    }

    const unfinishedToolCalls = deduplicateFunctionToolCalls(
      extractPendingFunctionToolCalls(latestResponseRecord),
    );
    if (unfinishedToolCalls.length > 0) {
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
    const stageOneAttemptAudit = parseInvestigatorAttemptAudit({
      ...stageOneAttemptAuditBase,
      completedAt: new Date().toISOString(),
      response: factCheckResponseAudit,
      error: null,
    });

    if (factCheckResponseAudit.responseStatus !== "completed") {
      const incompleteReason = readIncompleteReason(latestResponseRecord);
      const cause = new InvestigatorIncompleteResponseError({
        responseStatus: factCheckResponseAudit.responseStatus,
        responseId: factCheckResponseAudit.responseId,
        incompleteReason,
        outputTextLength: factCheckResponseAudit.responseOutputText?.length ?? 0,
      });
      throw new InvestigatorExecutionError(
        "OpenAI response was incomplete before structured output parsing",
        parseInvestigatorAttemptAudit({
          ...stageOneAttemptAudit,
          error: buildErrorAudit(cause),
        }),
        cause,
      );
    }

    let outputText: string;
    try {
      outputText = requireCompletedOutputText({
        responseAudit: factCheckResponseAudit,
        responseRecord: latestResponseRecord,
        context: "Fact-check response",
      });
    } catch (error) {
      throw new InvestigatorExecutionError(
        error instanceof Error ? error.message : "Model returned invalid structured output text",
        parseInvestigatorAttemptAudit({
          ...stageOneAttemptAudit,
          error: buildErrorAudit(error),
        }),
        error,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(outputText);
    } catch (error) {
      throw new InvestigatorExecutionError(
        "Model returned invalid JSON structured output",
        parseInvestigatorAttemptAudit({
          ...stageOneAttemptAudit,
          error: buildErrorAudit(error),
        }),
        error,
      );
    }
    let parsedRecord: Record<string, unknown>;
    try {
      parsedRecord = requireJsonObject(parsed, "Fact-check structured output");
    } catch (error) {
      throw new InvestigatorExecutionError(
        error instanceof Error
          ? error.message
          : "Model returned structured output with an invalid top-level type",
        parseInvestigatorAttemptAudit({
          ...stageOneAttemptAudit,
          error: buildErrorAudit(error),
        }),
        error,
      );
    }

    const claimDispositions: {
      index: number;
      claim: StageOneClaim;
      needsValidation: boolean;
      validationDescription: string;
    }[] = [];

    if (input.isUpdate !== true) {
      let factCheckResult: ReturnType<typeof investigationResultSchema.parse>;
      try {
        factCheckResult = investigationResultSchema.parse(parsedRecord);
      } catch (error) {
        throw new InvestigatorExecutionError(
          "Model returned structured output that failed schema validation",
          parseInvestigatorAttemptAudit({
            ...stageOneAttemptAudit,
            error: buildErrorAudit(error),
          }),
          error,
        );
      }

      for (const [index, claim] of factCheckResult.claims.entries()) {
        claimDispositions.push({
          index,
          claim,
          needsValidation: true,
          validationDescription: `Claim ${index.toString()}: per-claim validation`,
        });
      }
    } else {
      const updateSchema = buildUpdateInvestigationResultSchema(oldClaimIds);
      let updateResult: ReturnType<typeof updateSchema.parse>;
      try {
        updateResult = updateSchema.parse(parsedRecord);
      } catch (error) {
        throw new InvestigatorExecutionError(
          "Model returned structured output that failed update schema validation",
          parseInvestigatorAttemptAudit({
            ...stageOneAttemptAudit,
            error: buildErrorAudit(error),
          }),
          error,
        );
      }

      const oldClaims = input.oldClaims;
      const oldClaimsById = new Map(oldClaims.map((claim) => [claim.id as string, claim] as const));
      const carriedClaimIds = new Set<string>();

      for (const [index, action] of updateResult.actions.entries()) {
        if (action.type === "carry") {
          if (carriedClaimIds.has(action.id)) {
            const cause = new InvestigatorStructuredOutputError(
              `Update output included duplicate carry id (${action.id})`,
            );
            throw new InvestigatorExecutionError(
              cause.message,
              parseInvestigatorAttemptAudit({
                ...stageOneAttemptAudit,
                error: buildErrorAudit(cause),
              }),
              cause,
            );
          }
          // The schema's z.enum constraint guarantees action.id is one of the
          // old claim IDs, so this lookup always succeeds.
          const carriedClaim = oldClaimsById.get(action.id);
          if (carriedClaim === undefined) {
            throw new Error(
              `Invariant violation: carry id ${action.id} passed schema enum but missing from oldClaimsById`,
            );
          }
          carriedClaimIds.add(action.id);
          const { id: _claimId, ...claimPayload } = carriedClaim;
          claimDispositions.push({
            index,
            claim: claimPayload,
            needsValidation: false,
            validationDescription: `Action ${index.toString()}: carry ${action.id}`,
          });
          continue;
        }

        claimDispositions.push({
          index,
          claim: action.claim,
          needsValidation: true,
          validationDescription: `Action ${index.toString()}: new claim validation`,
        });
      }
    }

    const claimsToValidate = claimDispositions.filter((d) => d.needsValidation);

    const validationInputSummary = claimDispositions.map((d) => d.validationDescription).join("\n");
    const stageTwoInputSummary =
      validationImageContextNotes === undefined
        ? validationInputSummary
        : `${validationInputSummary}\n\nImage context notes:\n${validationImageContextNotes}`;

    const stageTwoAttemptAuditBase: Omit<InvestigatorAttemptAudit, "response" | "error"> = {
      ...stageOneAttemptAuditBase,
      requestInstructions: TWO_STEP_REQUEST_INSTRUCTIONS,
      requestInput: buildTwoStepRequestInputAudit(userPrompt, stageTwoInputSummary),
    };

    // Fast path: no new claims require validation (for example, pure carry actions).
    if (claimsToValidate.length === 0) {
      let result: InvestigationResult;
      try {
        result = investigationResultSchema.parse({
          claims: claimDispositions.map((d) => d.claim),
        });
      } catch (error) {
        throw new InvestigatorExecutionError(
          "Final investigation result failed schema validation",
          parseInvestigatorAttemptAudit({
            ...stageTwoAttemptAuditBase,
            completedAt: new Date().toISOString(),
            response: factCheckResponseAudit,
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
          response: factCheckResponseAudit,
          error: null,
        }),
        ...(factCheckResponseAudit.responseModelVersion != null && {
          modelVersion: factCheckResponseAudit.responseModelVersion,
        }),
      };
    }

    const validationResults: PerClaimValidationResult[] = [];

    for (
      let batchStart = 0;
      batchStart < claimsToValidate.length;
      batchStart += MAX_PER_CLAIM_VALIDATION_CONCURRENCY
    ) {
      const batch = claimsToValidate.slice(
        batchStart,
        batchStart + MAX_PER_CLAIM_VALIDATION_CONCURRENCY,
      );
      const outcomes = await Promise.all(
        batch.map(({ index, claim }) =>
          validateClaim(
            client,
            openAiModelId,
            index,
            claim,
            input.contentText,
            validationImageContextNotes,
            requestReasoning,
          ),
        ),
      );

      validationResults.push(...outcomes);

      if (outcomes.some((outcome) => outcome.error !== null)) {
        break;
      }
    }

    const failedValidations = validationResults.filter((result) => result.error !== null);
    const validationFailureResponseAudits = failedValidations.flatMap((result) =>
      result.responseAudit === null ? [] : [result.responseAudit],
    );
    const successfulValidations = validationResults.filter((result) => result.error === null);

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

    // Build the approved set: auto-approved old claims + validation-approved new claims.
    const approvedIndices = new Set<number>();
    for (const d of claimDispositions) {
      if (!d.needsValidation) {
        approvedIndices.add(d.index);
      }
    }
    for (const r of successfulValidations) {
      if (r.approved) {
        approvedIndices.add(r.claimIndex);
      }
    }

    const filteredClaims = claimDispositions
      .filter((d) => approvedIndices.has(d.index))
      .map((d) => d.claim);

    let result: InvestigationResult;
    try {
      result = investigationResultSchema.parse({ claims: filteredClaims });
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
