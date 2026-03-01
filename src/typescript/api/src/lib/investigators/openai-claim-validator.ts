import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { isNonNullObject, type InvestigationResult } from "@openerrata/shared";
import type { InvestigatorResponseAudit } from "./interface.js";
import { claimValidationResultSchema } from "./openai-schemas.js";
import {
  extractResponseAudit,
  readIncompleteReason,
  requireCompletedOutputText,
  requireJsonObject,
} from "./openai-response-audit.js";
import { INVESTIGATION_VALIDATION_SYSTEM_PROMPT, buildValidationPrompt } from "./prompt.js";

const isRecord = isNonNullObject;

export const MAX_PER_CLAIM_VALIDATION_CONCURRENCY = 4;

export class InvestigatorIncompleteResponseError extends Error {
  readonly responseStatus: string | null;
  readonly responseId: string | null;
  readonly incompleteReason: string | null;
  readonly outputTextLength: number;

  constructor(input: {
    responseStatus: string | null;
    responseId: string | null;
    incompleteReason: string | null;
    outputTextLength: number;
  }) {
    const statusPart = input.responseStatus ?? "unknown";
    const reasonPart = input.incompleteReason ?? "unknown";
    const responseIdPart = input.responseId ?? "unknown";
    super(
      "OpenAI response did not complete " +
        `(status=${statusPart}, reason=${reasonPart}, responseId=${responseIdPart}, outputTextLength=${input.outputTextLength.toString()})`,
    );
    this.name = "InvestigatorIncompleteResponseError";
    this.responseStatus = input.responseStatus;
    this.responseId = input.responseId;
    this.incompleteReason = input.incompleteReason;
    this.outputTextLength = input.outputTextLength;
  }
}

export interface PerClaimValidationResult {
  claimIndex: number;
  approved: boolean;
  responseAudit: InvestigatorResponseAudit | null;
  error: Error | null;
}

export async function validateClaim(
  client: OpenAI,
  modelId: string,
  claimIndex: number,
  claim: InvestigationResult["claims"][number],
  contentText: string,
  imageContextNotes: string | undefined,
  requestReasoning: {
    effort: "low" | "medium" | "high";
    summary: "auto" | "concise" | "detailed";
  },
): Promise<PerClaimValidationResult> {
  const validationPrompt = buildValidationPrompt({
    currentPostText: contentText,
    candidateClaim: claim,
    ...(imageContextNotes === undefined ? {} : { imageContextNotes }),
  });

  let response: unknown;
  try {
    response = await client.responses.create({
      model: modelId,
      stream: false,
      instructions: INVESTIGATION_VALIDATION_SYSTEM_PROMPT,
      input: validationPrompt,
      reasoning: requestReasoning,
      text: {
        format: zodTextFormat(claimValidationResultSchema, "claim_validation_result"),
      },
    });
  } catch (caught) {
    return {
      claimIndex,
      approved: false,
      responseAudit: null,
      error: caught instanceof Error ? caught : new Error(String(caught)),
    };
  }

  const responseRecord = isRecord(response) ? response : {};
  const responseAudit = extractResponseAudit(responseRecord);
  try {
    if (responseAudit.responseStatus !== "completed") {
      throw new InvestigatorIncompleteResponseError({
        responseStatus: responseAudit.responseStatus,
        responseId: responseAudit.responseId,
        incompleteReason: readIncompleteReason(responseRecord),
        outputTextLength: responseAudit.responseOutputText?.length ?? 0,
      });
    }

    const outputText = requireCompletedOutputText({
      responseAudit,
      responseRecord,
      context: "Claim validation response",
    });

    const parsed: unknown = JSON.parse(outputText);
    const { approved } = claimValidationResultSchema.parse(
      requireJsonObject(parsed, "Claim validation structured output"),
    );
    return { claimIndex, approved, responseAudit, error: null };
  } catch (caught) {
    return {
      claimIndex,
      approved: false,
      responseAudit,
      error: caught instanceof Error ? caught : new Error(String(caught)),
    };
  }
}
