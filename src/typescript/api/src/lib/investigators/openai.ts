import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  DEFAULT_INVESTIGATION_MODEL,
  DEFAULT_INVESTIGATION_PROVIDER,
  investigationResultSchema,
  validateAndSortImageOccurrences,
  type InvestigationResult,
} from "@openerrata/shared";
import { getEnv } from "$lib/config/env.js";
import {
  FETCH_URL_TOOL_NAME,
  executeFetchUrlTool,
  fetchUrlToolDefinition,
} from "./fetch-url-tool.js";
import {
  parseInvestigatorAttemptAudit,
  type Investigator,
  type InvestigatorAttemptAudit,
  type InvestigatorErrorAudit,
  type InvestigatorImageOccurrence,
  type InvestigatorInput,
  type InvestigatorJsonValue,
  type InvestigatorOutput,
  type InvestigatorOutputItemAudit,
  type InvestigatorOutputTextAnnotationAudit,
  type InvestigatorOutputTextPartAudit,
  type InvestigatorReasoningSummaryAudit,
  type InvestigatorRequestedToolAudit,
  type InvestigatorResponseAudit,
  type InvestigatorToolCallAudit,
  type InvestigatorUsageAudit,
} from "./interface.js";
import {
  INVESTIGATION_SYSTEM_PROMPT,
  INVESTIGATION_VALIDATION_SYSTEM_PROMPT,
  buildValidationPrompt,
  buildUserPrompt,
} from "./prompt.js";
import { readOpenAiStatusCode } from "$lib/openai/errors.js";

const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_REASONING_SUMMARY = "detailed";
const MAX_PER_CLAIM_VALIDATION_CONCURRENCY = 4;
const TWO_STEP_REQUEST_INSTRUCTIONS = `=== Stage 1: Fact-check instructions ===
${INVESTIGATION_SYSTEM_PROMPT}

=== Stage 2: Validation instructions ===
${INVESTIGATION_VALIDATION_SYSTEM_PROMPT}`;

function getOpenAiModelId(): string {
  return getEnv().OPENAI_MODEL_ID;
}

function getMaxResponseToolRounds(): number {
  return getEnv().OPENAI_MAX_RESPONSE_TOOL_ROUNDS;
}

const claimValidationResultSchema = z
  .object({
    approved: z.boolean(),
  })
  .strict();

// OpenAI structured outputs currently reject JSON Schema `format: "uri"`.
// Keep provider-facing schema to plain strings/patterns, then enforce the
// full shared schema (`investigationResultSchema`) before returning.
const providerStructuredSourceUrlSchema = z
  .string()
  .min(1)
  .regex(/^https?:\/\/\S+$/i, "Source URL must be an absolute http(s) URL");

const providerStructuredInvestigationClaimPayloadSchema = z
  .object({
    text: z.string().min(1),
    context: z.string().min(1),
    summary: z.string().min(1),
    reasoning: z.string().min(1),
    sources: z
      .array(
        z
          .object({
            url: providerStructuredSourceUrlSchema,
            title: z.string().min(1),
            snippet: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const providerStructuredInvestigationResultSchema = z
  .object({
    claims: z.array(providerStructuredInvestigationClaimPayloadSchema),
  })
  .strict();

const updateNewActionSchema = z
  .object({
    type: z.literal("new"),
    claim: providerStructuredInvestigationClaimPayloadSchema,
  })
  .strict();

/**
 * Build the update investigation result schema dynamically based on the set of
 * old claim IDs. When old claims exist, the model may emit "carry" actions
 * referencing exactly those IDs (enforced via z.enum) or "new" actions. When
 * there are no old claims, only "new" actions are permitted — carry actions are
 * structurally impossible.
 */
function buildUpdateInvestigationResultSchema(oldClaimIds: [string, ...string[]] | []) {
  const actionSchema =
    oldClaimIds.length > 0
      ? z.union([
          z
            .object({
              type: z.literal("carry"),
              id: z.enum(oldClaimIds as [string, ...string[]]),
            })
            .strict(),
          updateNewActionSchema,
        ])
      : updateNewActionSchema;

  return z.object({ actions: z.array(actionSchema) }).strict();
}

type StageOneClaim = InvestigationResult["claims"][number];

type PendingFunctionToolCall = {
  callId: string;
  name: string;
  argumentsJson: string;
};

type FunctionCallOutput = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

function buildTwoStepRequestInputAudit(userPrompt: string, validationPrompt: string): string {
  return `=== Stage 1: Fact-check input ===
${userPrompt}

=== Stage 2: Validation input ===
${validationPrompt}`;
}

function appendTextInputPart(
  contentParts: Array<
    | {
        type: "input_text";
        text: string;
      }
    | {
        type: "input_image";
        detail: "auto";
        image_url: string;
      }
  >,
  text: string,
): void {
  if (text.length === 0) return;
  contentParts.push({
    type: "input_text",
    text,
  });
}

function normalizeImageOccurrences(
  imageOccurrences: InvestigatorImageOccurrence[] | undefined,
  contentText?: string,
): InvestigatorImageOccurrence[] {
  return validateAndSortImageOccurrences(imageOccurrences, {
    ...(contentText === undefined ? {} : { contentTextLength: contentText.length }),
    onValidationIssue: (issue): never => {
      switch (issue.code) {
        case "NON_CONTIGUOUS_ORIGINAL_INDEX":
          throw new InvestigatorStructuredOutputError(
            "Image occurrences must use contiguous originalIndex values starting at 0",
          );
        case "OFFSET_EXCEEDS_CONTENT_LENGTH":
          throw new InvestigatorStructuredOutputError(
            "Image occurrence offset exceeds contentText length",
          );
        case "DECREASING_NORMALIZED_TEXT_OFFSET":
          throw new InvestigatorStructuredOutputError(
            "Image occurrences must be non-decreasing by normalizedTextOffset",
          );
      }
    },
  });
}

function buildValidationImageContextNotes(
  imageOccurrences: InvestigatorImageOccurrence[] | undefined,
): string | undefined {
  const normalizedOccurrences = normalizeImageOccurrences(imageOccurrences);
  if (normalizedOccurrences.length === 0) {
    return undefined;
  }

  const seenResolvedContentHashes = new Set<string>();
  const lines = normalizedOccurrences.map((occurrence, index) => {
    const captionPart =
      occurrence.captionText === undefined
        ? ""
        : `; caption=${JSON.stringify(occurrence.captionText)}`;

    if (occurrence.resolution === "resolved") {
      const status = seenResolvedContentHashes.has(occurrence.contentHash)
        ? "resolved_duplicate"
        : "resolved_first";
      seenResolvedContentHashes.add(occurrence.contentHash);
      return `${(index + 1).toString()}. offset=${occurrence.normalizedTextOffset}; status=${status}; sourceUrl=${occurrence.sourceUrl}${captionPart}`;
    }

    return `${(index + 1).toString()}. offset=${occurrence.normalizedTextOffset}; status=${occurrence.resolution}; sourceUrl=${occurrence.sourceUrl}${captionPart}`;
  });

  return lines.join("\n");
}

function buildInitialInput(
  userPrompt: string,
  contentText: string,
  imageOccurrences: InvestigatorImageOccurrence[] | undefined,
): string | ResponseInput {
  const normalizedOccurrences = normalizeImageOccurrences(imageOccurrences, contentText);
  if (normalizedOccurrences.length === 0) {
    return userPrompt;
  }

  const postTextStart = userPrompt.indexOf(contentText);
  const postTextEnd = postTextStart + contentText.length;
  if (postTextStart < 0) {
    throw new InvestigatorStructuredOutputError(
      "Post contentText was not found in the stage-1 user prompt",
    );
  }
  if (userPrompt.lastIndexOf(contentText) !== postTextStart) {
    throw new InvestigatorStructuredOutputError(
      "Post contentText appeared multiple times in the stage-1 user prompt",
    );
  }

  const contentParts: Array<
    | {
        type: "input_text";
        text: string;
      }
    | {
        type: "input_image";
        detail: "auto";
        image_url: string;
      }
  > = [];
  appendTextInputPart(contentParts, userPrompt.slice(0, postTextStart));

  const seenResolvedContentHashes = new Set<string>();
  let cursor = 0;
  let omittedCount = 0;
  for (const occurrence of normalizedOccurrences) {
    appendTextInputPart(contentParts, contentText.slice(cursor, occurrence.normalizedTextOffset));
    cursor = occurrence.normalizedTextOffset;

    if (occurrence.captionText !== undefined) {
      appendTextInputPart(contentParts, `[Image context] ${occurrence.captionText}`);
    }

    if (occurrence.resolution === "resolved") {
      if (seenResolvedContentHashes.has(occurrence.contentHash)) {
        appendTextInputPart(contentParts, "[Same image as earlier appears here.]");
        continue;
      }

      seenResolvedContentHashes.add(occurrence.contentHash);
      contentParts.push({
        type: "input_image",
        detail: "auto",
        image_url: occurrence.imageDataUri,
      });
      continue;
    }

    if (occurrence.resolution === "omitted") {
      omittedCount += 1;
      appendTextInputPart(
        contentParts,
        "[Image present in source but omitted due to image budget.]",
      );
      continue;
    }

    appendTextInputPart(
      contentParts,
      "[Image present in source but unavailable at inference time.]",
    );
  }

  appendTextInputPart(contentParts, contentText.slice(cursor));
  if (omittedCount > 0) {
    appendTextInputPart(
      contentParts,
      `[Note] ${omittedCount.toString()} image occurrence(s) were omitted due to image budget.`,
    );
  }
  appendTextInputPart(contentParts, userPrompt.slice(postTextEnd));

  const multimodalInput: ResponseInput = [
    {
      role: "user",
      content: contentParts,
    },
  ];

  return multimodalInput;
}

export const openAiInvestigatorInternals = {
  buildInitialInput,
  buildValidationImageContextNotes,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeJsonValue(value: unknown, depth = 0): InvestigatorJsonValue {
  if (depth > 8) return "[max-depth]";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    const sanitized: Record<string, InvestigatorJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      sanitized[key] = sanitizeJsonValue(entry, depth + 1);
    }
    return sanitized;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.description ?? "symbol";
  if (typeof value === "function") return "[function]";
  return "[unsupported]";
}

function sanitizeJsonRecord(value: unknown): Record<string, InvestigatorJsonValue> {
  return isRecord(value) ? (sanitizeJsonValue(value) as Record<string, InvestigatorJsonValue>) : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readOptionalInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function readIncompleteReason(responseRecord: Record<string, unknown>): string | null {
  const incompleteDetails = responseRecord["incomplete_details"];
  if (!isRecord(incompleteDetails)) return null;
  return readString(incompleteDetails["reason"]);
}

function getErrorStatus(error: unknown): number | null {
  return readOpenAiStatusCode(error);
}

function buildErrorAudit(error: unknown): InvestigatorErrorAudit {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      statusCode: getErrorStatus(error),
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: typeof error === "string" ? error : "unknown",
    statusCode: getErrorStatus(error),
  };
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Handle seconds and milliseconds unix timestamps.
    const normalized = value > 1_000_000_000_000 ? value : value * 1000;
    const date = new Date(normalized);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }

  return null;
}

function findTimestamp(value: unknown, candidateKeys: Set<string>, depth = 0): string | null {
  if (depth > 6) return null;

  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (candidateKeys.has(normalizedKey)) {
        const parsed = parseTimestamp(nested);
        if (parsed !== null && parsed.length > 0) return parsed;
      }
      const nestedResult = findTimestamp(nested, candidateKeys, depth + 1);
      if (nestedResult !== null && nestedResult.length > 0) return nestedResult;
    }
  } else if (Array.isArray(value)) {
    for (const nested of value) {
      const nestedResult = findTimestamp(nested, candidateKeys, depth + 1);
      if (nestedResult !== null && nestedResult.length > 0) return nestedResult;
    }
  }

  return null;
}

function extractRequestedTools(tools: unknown): InvestigatorRequestedToolAudit[] {
  if (!Array.isArray(tools)) return [];

  const extracted: InvestigatorRequestedToolAudit[] = [];
  for (const [index, tool] of tools.entries()) {
    if (!isRecord(tool)) continue;

    extracted.push({
      requestOrder: index,
      toolType: readString(tool["type"]) ?? "unknown",
      rawDefinition: sanitizeJsonRecord(tool),
    });
  }

  return extracted;
}

function extractOutputItems(outputItems: unknown[]): InvestigatorOutputItemAudit[] {
  const extracted: InvestigatorOutputItemAudit[] = [];

  for (const [outputIndex, outputItem] of outputItems.entries()) {
    if (!isRecord(outputItem)) {
      extracted.push({
        outputIndex,
        providerItemId: null,
        itemType: "unknown",
        itemStatus: null,
      });
      continue;
    }

    const providerItemId = readString(outputItem["id"]);
    const itemStatus = readString(outputItem["status"]);
    extracted.push({
      outputIndex,
      providerItemId: providerItemId === null || itemStatus === null ? null : providerItemId,
      itemType: readString(outputItem["type"]) ?? "unknown",
      itemStatus: providerItemId === null || itemStatus === null ? null : itemStatus,
    });
  }

  return extracted;
}

function extractOutputTextArtifacts(outputItems: unknown[]): {
  parts: InvestigatorOutputTextPartAudit[];
  annotations: InvestigatorOutputTextAnnotationAudit[];
} {
  const parts: InvestigatorOutputTextPartAudit[] = [];
  const annotations: InvestigatorOutputTextAnnotationAudit[] = [];

  for (const [outputIndex, outputItem] of outputItems.entries()) {
    if (!isRecord(outputItem) || outputItem["type"] !== "message") continue;

    const content = outputItem["content"];
    if (!Array.isArray(content)) continue;

    for (const [partIndex, part] of content.entries()) {
      if (!isRecord(part)) continue;

      const partType = readString(part["type"]);
      if (partType === "output_text") {
        const text = readString(part["text"]);
        if (text === null || text.length === 0) continue;

        parts.push({
          outputIndex,
          partIndex,
          partType,
          text,
        });

        const partAnnotations = part["annotations"];
        if (!Array.isArray(partAnnotations)) continue;

        for (const [annotationIndex, annotation] of partAnnotations.entries()) {
          if (!isRecord(annotation)) continue;

          const startIndex = readOptionalInteger(annotation["start_index"]);
          const endIndex = readOptionalInteger(annotation["end_index"]);

          const characterPosition =
            startIndex === null || endIndex === null
              ? undefined
              : {
                  start: startIndex,
                  end: endIndex,
                };

          annotations.push({
            outputIndex,
            partIndex,
            annotationIndex,
            annotationType: readString(annotation["type"]) ?? "unknown",
            characterPosition,
            url: readString(annotation["url"]),
            title: readString(annotation["title"]),
            fileId: readString(annotation["file_id"]),
          });
        }

        continue;
      }

      if (partType === "refusal") {
        const refusal = readString(part["refusal"]);
        if (refusal === null || refusal.length === 0) continue;

        parts.push({
          outputIndex,
          partIndex,
          partType,
          text: refusal,
        });
      }
    }
  }

  return { parts, annotations };
}

function extractReasoningSummaries(outputItems: unknown[]): InvestigatorReasoningSummaryAudit[] {
  const summaries: InvestigatorReasoningSummaryAudit[] = [];

  for (const [outputIndex, outputItem] of outputItems.entries()) {
    if (!isRecord(outputItem) || outputItem["type"] !== "reasoning") continue;

    const summary = outputItem["summary"];
    if (!Array.isArray(summary)) continue;

    for (const [summaryIndex, summaryPart] of summary.entries()) {
      if (!isRecord(summaryPart)) continue;
      const text = readString(summaryPart["text"]);
      if (text === null || text.length === 0) continue;

      summaries.push({
        outputIndex,
        summaryIndex,
        text,
      });
    }
  }

  return summaries;
}

function toToolCallAudit(
  outputIndex: number,
  outputItem: unknown,
): InvestigatorToolCallAudit | null {
  if (!isRecord(outputItem)) return null;
  const type = outputItem["type"];
  if (type === "message" || type === "reasoning") {
    return null;
  }
  if (typeof type !== "string" || type.length === 0) return null;

  const providerStartedAt = findTimestamp(
    outputItem,
    new Set(["started_at", "start_time", "created_at", "createdat", "requested_at", "timestamp"]),
  );
  const providerCompletedAt = findTimestamp(
    outputItem,
    new Set(["completed_at", "finished_at", "ended_at", "updated_at", "completedat", "finishedat"]),
  );
  const providerToolCallId = readString(outputItem["id"]);
  const status = readString(outputItem["status"]);

  return {
    outputIndex,
    providerToolCallId: providerToolCallId === null || status === null ? null : providerToolCallId,
    toolType: type,
    status: providerToolCallId === null || status === null ? null : status,
    rawPayload: sanitizeJsonRecord(outputItem),
    capturedAt: new Date().toISOString(),
    providerStartedAt,
    providerCompletedAt,
  };
}

function extractToolCalls(outputItems: unknown[]): InvestigatorToolCallAudit[] {
  const entries: InvestigatorToolCallAudit[] = [];
  for (const [outputIndex, outputItem] of outputItems.entries()) {
    const entry = toToolCallAudit(outputIndex, outputItem);
    if (entry) entries.push(entry);
  }
  return entries;
}

function extractUsage(responseRecord: Record<string, unknown>): InvestigatorUsageAudit | null {
  const usageValue = responseRecord["usage"];
  if (!isRecord(usageValue)) return null;

  const inputTokens = readOptionalInteger(usageValue["input_tokens"]);
  const outputTokens = readOptionalInteger(usageValue["output_tokens"]);
  const totalTokens = readOptionalInteger(usageValue["total_tokens"]);
  if (inputTokens === null || outputTokens === null || totalTokens === null) {
    return null;
  }

  const inputDetails = isRecord(usageValue["input_tokens_details"])
    ? usageValue["input_tokens_details"]
    : null;
  const outputDetails = isRecord(usageValue["output_tokens_details"])
    ? usageValue["output_tokens_details"]
    : null;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: readOptionalInteger(inputDetails?.["cached_tokens"]),
    reasoningOutputTokens: readOptionalInteger(outputDetails?.["reasoning_tokens"]),
  };
}

function extractResponseAudit(responseRecord: Record<string, unknown>): InvestigatorResponseAudit {
  const outputItems = Array.isArray(responseRecord["output"]) ? responseRecord["output"] : [];

  const outputTextArtifacts = extractOutputTextArtifacts(outputItems);

  return {
    responseId: readString(responseRecord["id"]),
    responseStatus: readString(responseRecord["status"]),
    responseModelVersion: readString(responseRecord["model"]),
    responseOutputText: readString(responseRecord["output_text"]),
    outputItems: extractOutputItems(outputItems),
    outputTextParts: outputTextArtifacts.parts,
    outputTextAnnotations: outputTextArtifacts.annotations,
    reasoningSummaries: extractReasoningSummaries(outputItems),
    toolCalls: extractToolCalls(outputItems),
    usage: extractUsage(responseRecord),
  };
}

function offsetResponseAuditIndices(
  audit: InvestigatorResponseAudit,
  outputIndexOffset: number,
): InvestigatorResponseAudit {
  if (outputIndexOffset === 0) return audit;

  return {
    ...audit,
    outputItems: audit.outputItems.map((item) => ({
      ...item,
      outputIndex: item.outputIndex + outputIndexOffset,
    })),
    outputTextParts: audit.outputTextParts.map((part) => ({
      ...part,
      outputIndex: part.outputIndex + outputIndexOffset,
    })),
    outputTextAnnotations: audit.outputTextAnnotations.map((annotation) => ({
      ...annotation,
      outputIndex: annotation.outputIndex + outputIndexOffset,
    })),
    reasoningSummaries: audit.reasoningSummaries.map((summary) => ({
      ...summary,
      outputIndex: summary.outputIndex + outputIndexOffset,
    })),
    toolCalls: audit.toolCalls.map((toolCall) => ({
      ...toolCall,
      outputIndex: toolCall.outputIndex + outputIndexOffset,
    })),
  };
}

function aggregateUsage(usages: (InvestigatorUsageAudit | null)[]): InvestigatorUsageAudit | null {
  const presentUsages = usages.filter((usage): usage is InvestigatorUsageAudit => usage !== null);
  if (presentUsages.length === 0) return null;

  return presentUsages.reduce<InvestigatorUsageAudit>(
    (accumulator, usage) => ({
      inputTokens: accumulator.inputTokens + usage.inputTokens,
      outputTokens: accumulator.outputTokens + usage.outputTokens,
      totalTokens: accumulator.totalTokens + usage.totalTokens,
      cachedInputTokens: (accumulator.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
      reasoningOutputTokens:
        (accumulator.reasoningOutputTokens ?? 0) + (usage.reasoningOutputTokens ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    },
  );
}

function mergeResponseAudits(
  responseAudits: InvestigatorResponseAudit[],
): InvestigatorResponseAudit {
  if (responseAudits.length === 0) {
    throw new Error("Cannot merge empty response audits");
  }

  const finalAudit = responseAudits[responseAudits.length - 1];
  if (!finalAudit) throw new Error("Cannot merge empty response audits");
  return {
    responseId: finalAudit.responseId,
    responseStatus: finalAudit.responseStatus,
    responseModelVersion: finalAudit.responseModelVersion,
    responseOutputText: finalAudit.responseOutputText,
    outputItems: responseAudits.flatMap((audit) => audit.outputItems),
    outputTextParts: responseAudits.flatMap((audit) => audit.outputTextParts),
    outputTextAnnotations: responseAudits.flatMap((audit) => audit.outputTextAnnotations),
    reasoningSummaries: responseAudits.flatMap((audit) => audit.reasoningSummaries),
    toolCalls: responseAudits.flatMap((audit) => audit.toolCalls),
    usage: aggregateUsage(responseAudits.map((audit) => audit.usage)),
  };
}

function extractPendingFunctionToolCalls(
  responseRecord: Record<string, unknown>,
): PendingFunctionToolCall[] {
  const outputItems = Array.isArray(responseRecord["output"]) ? responseRecord["output"] : [];

  const calls: PendingFunctionToolCall[] = [];
  for (const outputItem of outputItems) {
    if (!isRecord(outputItem) || outputItem["type"] !== "function_call") continue;

    const callId = readString(outputItem["call_id"]);
    const name = readString(outputItem["name"]);
    const argumentsJson = readString(outputItem["arguments"]);
    if (
      callId === null ||
      callId.length === 0 ||
      name === null ||
      name.length === 0 ||
      argumentsJson === null
    ) {
      continue;
    }

    calls.push({ callId, name, argumentsJson });
  }

  return calls;
}

function deduplicateFunctionToolCalls(calls: PendingFunctionToolCall[]): PendingFunctionToolCall[] {
  const deduplicated: PendingFunctionToolCall[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.callId)) continue;
    seen.add(call.callId);
    deduplicated.push(call);
  }
  return deduplicated;
}

async function executeFunctionToolCall(call: PendingFunctionToolCall): Promise<FunctionCallOutput> {
  if (call.name === FETCH_URL_TOOL_NAME) {
    const toolOutput = await executeFetchUrlTool(call.argumentsJson);
    return {
      type: "function_call_output",
      call_id: call.callId,
      output: JSON.stringify(toolOutput),
    };
  }

  return {
    type: "function_call_output",
    call_id: call.callId,
    output: JSON.stringify({
      ok: false,
      error: `Unknown function tool: ${call.name}`,
    }),
  };
}

export class InvestigatorStructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigatorStructuredOutputError";
  }
}

class InvestigatorIncompleteResponseError extends Error {
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

type PerClaimValidationResult = {
  claimIndex: number;
  approved: boolean;
  responseAudit: InvestigatorResponseAudit | null;
  error: Error | null;
};

async function validateClaim(
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

    const outputText = responseAudit.responseOutputText ?? "";
    if (outputText.trim().length === 0) {
      throw new InvestigatorStructuredOutputError(
        "Claim validation returned empty structured output",
      );
    }

    const parsed: unknown = JSON.parse(outputText);
    const { approved } = claimValidationResultSchema.parse(parsed);
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
      ...(input.isUpdate !== undefined && { isUpdate: input.isUpdate }),
      ...(input.oldClaims !== undefined && { oldClaims: input.oldClaims }),
      ...(input.contentDiff !== undefined && { contentDiff: input.contentDiff }),
    });
    const initialInput = buildInitialInput(userPrompt, input.contentText, input.imageOccurrences);
    const validationImageContextNotes = buildValidationImageContextNotes(input.imageOccurrences);
    const client = this.client;

    const requestedTools = [{ type: "web_search_preview" as const }, fetchUrlToolDefinition];
    const requestReasoning = {
      effort: DEFAULT_REASONING_EFFORT as "low" | "medium" | "high",
      summary: DEFAULT_REASONING_SUMMARY as "auto" | "concise" | "detailed",
    };
    const oldClaimIds = (input.oldClaims ?? []).map((c) => c.id) as [string, ...string[]] | [];
    const stageOneFormat =
      input.isUpdate === true
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

    const outputText = factCheckResponseAudit.responseOutputText ?? "";
    if (outputText.trim().length === 0) {
      const cause = new InvestigatorStructuredOutputError("Model returned empty structured output");
      throw new InvestigatorExecutionError(
        cause.message,
        parseInvestigatorAttemptAudit({
          ...stageOneAttemptAudit,
          error: buildErrorAudit(cause),
        }),
        cause,
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

    const claimDispositions: Array<{
      index: number;
      claim: StageOneClaim;
      needsValidation: boolean;
      validationDescription: string;
    }> = [];

    if (input.isUpdate !== true) {
      let factCheckResult: ReturnType<typeof investigationResultSchema.parse>;
      try {
        factCheckResult = investigationResultSchema.parse(parsed);
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
      let updateResult: z.infer<typeof updateSchema>;
      try {
        updateResult = updateSchema.parse(parsed);
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

      const oldClaims = input.oldClaims ?? [];
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
      ...successfulValidations.flatMap((result) =>
        result.responseAudit === null ? [] : [result.responseAudit],
      ),
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
