import type OpenAI from "openai";
import type { Response } from "openai/resources/responses/responses";
import type { InvestigationClaimPayload } from "@openerrata/shared";
import {
  InvestigatorIncompleteResponseError,
  InvestigatorStructuredOutputError,
} from "./errors.js";
import type { InvestigatorRequestAudit } from "./interface.js";
import {
  buildClaimValidationRequestParams,
  claimValidationVerdictSchema,
  type InvestigationRequestConfig,
} from "./openai-request-config.js";
import { auditRequest, auditResponse } from "./openai-response-audit.js";
import { buildValidationPrompt } from "./prompt.js";

export const MAX_PER_CLAIM_VALIDATION_CONCURRENCY = 4;

/** Outcome of one stage-2 validation call (SPEC §2.4.3.2). Never a rejection. */
export type ClaimValidationResult =
  | { kind: "approved"; claimIndex: number; request: InvestigatorRequestAudit }
  | { kind: "rejected"; claimIndex: number; request: InvestigatorRequestAudit }
  | { kind: "failed"; claimIndex: number; request: InvestigatorRequestAudit; error: Error };

function toError(caught: unknown): Error {
  return caught instanceof Error ? caught : new Error(String(caught));
}

/** The verdict in a completed validation response; throws when there is none. */
function readVerdict(response: Response): boolean {
  if (response.status !== "completed") {
    throw new InvestigatorIncompleteResponseError({
      responseStatus: response.status ?? null,
      responseId: response.id,
      incompleteReason: response.incomplete_details?.reason ?? null,
    });
  }

  const outputText = response.output
    .flatMap((item) => (item.type === "message" ? item.content : []))
    .flatMap((part) => (part.type === "output_text" ? [part.text] : []))
    .join("");

  let decoded: unknown;
  try {
    decoded = JSON.parse(outputText);
  } catch {
    throw new InvestigatorStructuredOutputError(
      `Claim validation response ${response.id} did not return a JSON verdict`,
    );
  }
  const verdict = claimValidationVerdictSchema.safeParse(decoded);
  if (!verdict.success) {
    throw new InvestigatorStructuredOutputError(
      `Claim validation response ${response.id} returned an invalid verdict: ${verdict.error.message}`,
    );
  }
  return verdict.data.approved;
}

export async function validateClaim(input: {
  client: OpenAI;
  requestConfig: InvestigationRequestConfig;
  claimIndex: number;
  claim: InvestigationClaimPayload;
  contentText: string;
  imageContextNotes: string | undefined;
  signal: AbortSignal;
}): Promise<ClaimValidationResult> {
  const { claimIndex } = input;
  const validationPrompt = buildValidationPrompt({
    currentPostText: input.contentText,
    candidateClaim: input.claim,
    ...(input.imageContextNotes === undefined
      ? {}
      : { imageContextNotes: input.imageContextNotes }),
  });
  const params = buildClaimValidationRequestParams(input.requestConfig, validationPrompt);
  const subject = { kind: "CLAIM_VALIDATION", claimIndex } as const;

  let response: Response;
  try {
    response = await input.client.responses.create(params, { signal: input.signal });
  } catch (caught) {
    return {
      kind: "failed",
      claimIndex,
      request: auditRequest({ subject, params, auditInput: validationPrompt, response: null }),
      error: toError(caught),
    };
  }

  const request = auditRequest({
    subject,
    params,
    auditInput: validationPrompt,
    response: auditResponse(response, new Date()),
  });
  try {
    return readVerdict(response)
      ? { kind: "approved", claimIndex, request }
      : { kind: "rejected", claimIndex, request };
  } catch (caught) {
    return { kind: "failed", claimIndex, request, error: toError(caught) };
  }
}
