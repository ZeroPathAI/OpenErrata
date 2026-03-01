import { isNonNullObject } from "@openerrata/shared";
import { InvestigatorStructuredOutputError } from "./openai-errors.js";
import type {
  InvestigatorErrorAudit,
  InvestigatorJsonValue,
  InvestigatorOutputItemAudit,
  InvestigatorOutputTextAnnotationAudit,
  InvestigatorOutputTextPartAudit,
  InvestigatorReasoningSummaryAudit,
  InvestigatorRequestedToolAudit,
  InvestigatorResponseAudit,
  InvestigatorToolCallAudit,
  InvestigatorUsageAudit,
} from "./interface.js";
import { readOpenAiStatusCode } from "$lib/openai/errors.js";

const isRecord = isNonNullObject;

export function sanitizeJsonValue(value: unknown, depth = 0): InvestigatorJsonValue {
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

export function sanitizeJsonRecord(value: unknown): Record<string, InvestigatorJsonValue> {
  const record = requireJsonObject(value, "OpenAI audit payload");
  const sanitized: Record<string, InvestigatorJsonValue> = {};
  for (const [key, entry] of Object.entries(record)) {
    sanitized[key] = sanitizeJsonValue(entry, 1);
  }
  return sanitized;
}

export function describeJsonValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function requireJsonObject(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new InvestigatorStructuredOutputError(
      `${context} must be a JSON object (received ${describeJsonValueType(value)})`,
    );
  }
  return value;
}

export function requireCompletedOutputText(input: {
  responseAudit: InvestigatorResponseAudit;
  responseRecord: Record<string, unknown>;
  context: string;
}): string {
  const outputText = input.responseAudit.responseOutputText;
  if (outputText === null) {
    const rawOutputTextType = describeJsonValueType(input.responseRecord["output_text"]);
    throw new InvestigatorStructuredOutputError(
      `${input.context} completed without output_text (responseId=${input.responseAudit.responseId ?? "unknown"}, output_text_type=${rawOutputTextType})`,
    );
  }

  if (outputText.trim().length === 0) {
    throw new InvestigatorStructuredOutputError(
      `${input.context} returned empty structured output`,
    );
  }

  return outputText;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function readOptionalInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function readIncompleteReason(responseRecord: Record<string, unknown>): string | null {
  const incompleteDetails = responseRecord["incomplete_details"];
  if (!isRecord(incompleteDetails)) return null;
  return readString(incompleteDetails["reason"]);
}

export function buildErrorAudit(error: unknown): InvestigatorErrorAudit {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      statusCode: readOpenAiStatusCode(error),
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: typeof error === "string" ? error : "unknown",
    statusCode: readOpenAiStatusCode(error),
  };
}

export function parseTimestamp(value: unknown): string | null {
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

export function findTimestamp(
  value: unknown,
  candidateKeys: Set<string>,
  depth = 0,
): string | null {
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

export function extractRequestedTools(tools: unknown): InvestigatorRequestedToolAudit[] {
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

export function extractOutputItems(outputItems: unknown[]): InvestigatorOutputItemAudit[] {
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

export function extractOutputTextArtifacts(outputItems: unknown[]): {
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

export function extractReasoningSummaries(
  outputItems: unknown[],
): InvestigatorReasoningSummaryAudit[] {
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

export function extractToolCalls(outputItems: unknown[]): InvestigatorToolCallAudit[] {
  const entries: InvestigatorToolCallAudit[] = [];
  for (const [outputIndex, outputItem] of outputItems.entries()) {
    const entry = toToolCallAudit(outputIndex, outputItem);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function extractUsage(
  responseRecord: Record<string, unknown>,
): InvestigatorUsageAudit | null {
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

export function extractResponseAudit(
  responseRecord: Record<string, unknown>,
): InvestigatorResponseAudit {
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

export function offsetResponseAuditIndices(
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

export function aggregateUsage(
  usages: (InvestigatorUsageAudit | null)[],
): InvestigatorUsageAudit | null {
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

export function mergeResponseAudits(
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
