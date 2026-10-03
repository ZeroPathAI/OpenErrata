import OpenAI from "openai";
import pLimit from "p-limit";
import type { InvestigationClaimPayload } from "@openerrata/shared";
import { getEnv } from "$lib/config/env.js";
import {
  InvestigatorExecutionError,
  InvestigatorIncompleteResponseError,
  InvestigatorStructuredOutputError,
} from "./errors.js";
import type {
  InvestigateOptions,
  Investigator,
  InvestigatorInput,
  InvestigatorOutput,
  InvestigatorRequestAudit,
} from "./interface.js";
import {
  parseRetainCorrectionArguments,
  parseSubmitCorrectionArguments,
} from "./openai-claim-tools.js";
import { createClaimValidationScheduler } from "./openai-claim-validation-scheduler.js";
import {
  MAX_PER_CLAIM_VALIDATION_CONCURRENCY,
  validateClaim,
  type ClaimValidationResult,
} from "./openai-claim-validator.js";
import { buildInitialInput, buildValidationImageContextNotes } from "./openai-input-builder.js";
import {
  createInvestigationRunState,
  getConfirmedClaims,
} from "./openai-investigation-run-state.js";
import {
  buildFactCheckTools,
  INVESTIGATION_REQUEST_CONFIG,
  type InvestigationRequestConfig,
} from "./openai-request-config.js";
import { buildErrorAudit } from "./openai-response-audit.js";
import {
  buildFunctionCallOutput,
  dispatchFunctionToolCalls,
  executeFunctionToolCall,
  type FunctionCallOutput,
  type PendingFunctionToolCall,
} from "./openai-tool-dispatch.js";
import { runToolLoop } from "./openai-tool-loop.js";
import {
  INVESTIGATION_SYSTEM_PROMPT,
  INVESTIGATION_UPDATE_SYSTEM_PROMPT,
  buildUserPrompt,
} from "./prompt.js";

interface OpenAIInvestigatorConfig {
  client: OpenAI;
  requestConfig: InvestigationRequestConfig;
  /** Upper bound on stage-1 fact-check rounds (provider requests); at least 1. */
  maxToolRounds: number;
}

const ACKNOWLEDGED_OUTPUT = JSON.stringify({ acknowledged: true });

function nonEmptyClaimIds(input: InvestigatorInput): readonly [string, ...string[]] | null {
  if (input.isUpdate !== true) {
    return null;
  }
  const [firstClaim, ...remainingClaims] = input.oldClaims;
  return firstClaim === undefined
    ? null
    : [firstClaim.id, ...remainingClaims.map((claim) => claim.id)];
}

/**
 * Two-stage OpenAI investigation (SPEC §2.4): a stage-1 fact-check tool loop
 * in which the model submits candidate claims, and a stage-2 validation call
 * per candidate, started as each claim is submitted.
 */
export class OpenAIInvestigator implements Investigator {
  private readonly config: OpenAIInvestigatorConfig;

  constructor(config: OpenAIInvestigatorConfig) {
    if (!Number.isInteger(config.maxToolRounds) || config.maxToolRounds < 1) {
      throw new Error(
        `maxToolRounds must be a positive integer (got ${config.maxToolRounds.toString()})`,
      );
    }
    this.config = config;
  }

  async investigate(
    input: InvestigatorInput,
    options: InvestigateOptions,
  ): Promise<InvestigatorOutput> {
    const { client, requestConfig } = this.config;
    const { signal } = options;
    const startedAt = new Date();

    const userPrompt = buildUserPrompt(input);
    const initialInput = buildInitialInput(
      userPrompt.prompt,
      userPrompt.contentString,
      userPrompt.contentOffset,
      input.imageOccurrences,
      input.imagePlaceholders,
    );
    const validationImageContextNotes = buildValidationImageContextNotes(input.imageOccurrences);
    const retainableClaimIds = nonEmptyClaimIds(input);

    const validationLimiter = pLimit(MAX_PER_CLAIM_VALIDATION_CONCURRENCY);
    const validations = createClaimValidationScheduler({
      initialState: createInvestigationRunState(
        input.isUpdate === true ? { oldClaims: input.oldClaims } : {},
      ),
      validationLimiter,
      runValidation: (claimIndex, claim) =>
        validateClaim({
          client,
          requestConfig,
          claimIndex,
          claim,
          contentText: input.contentText,
          imageContextNotes: validationImageContextNotes,
          signal,
        }),
      ...(options.callbacks === undefined ? {} : { callbacks: options.callbacks }),
    });

    const submitCorrection = (call: PendingFunctionToolCall): FunctionCallOutput => {
      const claim = parseSubmitCorrectionArguments(call.argumentsJson);
      if (claim.kind === "invalid") {
        return buildFunctionCallOutput(
          call.callId,
          JSON.stringify({ error: `Invalid claim, not recorded: ${claim.error}` }),
        );
      }
      validations.scheduleClaimValidation(claim.value);
      return buildFunctionCallOutput(call.callId, ACKNOWLEDGED_OUTPUT);
    };

    const retainCorrection = (call: PendingFunctionToolCall): FunctionCallOutput => {
      if (retainableClaimIds === null) {
        return buildFunctionCallOutput(
          call.callId,
          JSON.stringify({ error: "There are no prior claims to retain" }),
        );
      }
      const claimId = parseRetainCorrectionArguments(call.argumentsJson, retainableClaimIds);
      if (claimId.kind === "invalid") {
        return buildFunctionCallOutput(
          call.callId,
          JSON.stringify({ error: `Invalid retain arguments: ${claimId.error}` }),
        );
      }
      const retained = validations.retainClaimById(claimId.value);
      return buildFunctionCallOutput(
        call.callId,
        retained.kind === "error"
          ? JSON.stringify({ error: retained.errorMessage })
          : ACKNOWLEDGED_OUTPUT,
      );
    };

    const loop = await runToolLoop({
      client,
      requestConfig,
      maxRounds: this.config.maxToolRounds,
      instructions:
        input.isUpdate === true ? INVESTIGATION_UPDATE_SYSTEM_PROMPT : INVESTIGATION_SYSTEM_PROMPT,
      tools: buildFactCheckTools(retainableClaimIds),
      initialInput,
      signal,
      handleFunctionCalls: (calls) =>
        dispatchFunctionToolCalls(calls, {
          submitCorrection,
          retainCorrection,
          research: (call) => executeFunctionToolCall(call, signal),
        }),
    });

    // Validations already scheduled run to completion on every path, so the
    // attempt audit records each request that was made.
    const validationResults = await validations.awaitAllValidations();
    const requests: InvestigatorRequestAudit[] = [
      ...loop.rounds,
      ...validationResults.map((validation) => validation.request),
    ];
    const fail = (message: string, cause: unknown): InvestigatorExecutionError =>
      new InvestigatorExecutionError(
        message,
        {
          outcome: "FAILED",
          startedAt,
          completedAt: new Date(),
          requests,
          error: buildErrorAudit(cause),
        },
        cause,
      );

    switch (loop.kind) {
      case "failed":
        throw fail("OpenAI fact-check round failed", loop.error);
      case "round_limit":
        throw fail(
          "Fact-check exceeded its tool round limit",
          new InvestigatorStructuredOutputError(
            `Model exceeded tool call round limit (${this.config.maxToolRounds.toString()})`,
          ),
        );
      case "response_not_completed":
        throw fail(
          "OpenAI fact-check response was incomplete",
          new InvestigatorIncompleteResponseError({
            responseStatus: loop.response.status ?? null,
            responseId: loop.response.id,
            incompleteReason: loop.response.incomplete_details?.reason ?? null,
          }),
        );
      case "completed":
        break;
    }

    const failedValidations = validationResults.filter(
      (validation): validation is Extract<ClaimValidationResult, { kind: "failed" }> =>
        validation.kind === "failed",
    );
    const [firstFailedValidation] = failedValidations;
    if (firstFailedValidation !== undefined) {
      const failedClaimIndices = failedValidations
        .map((validation) => validation.claimIndex.toString())
        .join(", ");
      throw fail(
        `Per-claim validation failed for claim indices: ${failedClaimIndices}`,
        firstFailedValidation.error,
      );
    }

    // Submitted claims were validated against the shared claim payload schema
    // on submission; retained claims are prior investigations' persisted claims.
    const claims: InvestigationClaimPayload[] = getConfirmedClaims(validations.getState());
    return {
      result: { claims },
      attemptAudit: { outcome: "SUCCEEDED", startedAt, completedAt: new Date(), requests },
      model: requestConfig.model,
      modelVersion: loop.finalResponse.model,
    };
  }
}

/** The production investigator factory: gpt-6.1-sol with the deployment's tool-round budget. */
export function createOpenAIInvestigator(apiKey: string): Investigator {
  return new OpenAIInvestigator({
    client: new OpenAI({ apiKey }),
    requestConfig: INVESTIGATION_REQUEST_CONFIG,
    maxToolRounds: getEnv().OPENAI_MAX_RESPONSE_TOOL_ROUNDS,
  });
}
