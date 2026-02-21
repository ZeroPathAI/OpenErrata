import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import {
  DEFAULT_INVESTIGATION_MODEL,
  DEFAULT_INVESTIGATION_PROVIDER,
  investigationResultSchema,
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
  buildUserPrompt,
} from "./prompt.js";

const OPENAI_MODEL_ID = getEnv().OPENAI_MODEL_ID;
const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_REASONING_SUMMARY = "detailed";
const MAX_RESPONSE_TOOL_ROUNDS = getEnv().OPENAI_MAX_RESPONSE_TOOL_ROUNDS;

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

function buildInitialInput(
  userPrompt: string,
  imageUrls: string[] | undefined,
): string | ResponseInput {
  if (!imageUrls || imageUrls.length === 0) {
    return userPrompt;
  }

  const multimodalInput: ResponseInput = [
    {
      role: "user",
      content: [
        { type: "input_text", text: userPrompt },
        ...imageUrls.map((url) => ({
          type: "input_image" as const,
          detail: "auto" as const,
          image_url: url,
        })),
      ],
    },
  ];

  return multimodalInput;
}

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
  return isRecord(value)
    ? (sanitizeJsonValue(value) as Record<string, InvestigatorJsonValue>)
    : {};
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
  if (!isRecord(error)) return null;
  const status = error["status"];
  return typeof status === "number" ? status : null;
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

function findTimestamp(
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
        if (parsed) return parsed;
      }
      const nestedResult = findTimestamp(nested, candidateKeys, depth + 1);
      if (nestedResult) return nestedResult;
    }
  } else if (Array.isArray(value)) {
    for (const nested of value) {
      const nestedResult = findTimestamp(nested, candidateKeys, depth + 1);
      if (nestedResult) return nestedResult;
    }
  }

  return null;
}

function extractRequestedTools(
  tools: unknown,
): InvestigatorRequestedToolAudit[] {
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

    extracted.push({
      outputIndex,
      providerItemId: readString(outputItem["id"]),
      itemType: readString(outputItem["type"]) ?? "unknown",
      itemStatus: readString(outputItem["status"]),
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
        if (!text) continue;

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

          annotations.push({
            outputIndex,
            partIndex,
            annotationIndex,
            annotationType: readString(annotation["type"]) ?? "unknown",
            startIndex: readOptionalInteger(annotation["start_index"]),
            endIndex: readOptionalInteger(annotation["end_index"]),
            url: readString(annotation["url"]),
            title: readString(annotation["title"]),
            fileId: readString(annotation["file_id"]),
          });
        }

        continue;
      }

      if (partType === "refusal") {
        const refusal = readString(part["refusal"]);
        if (!refusal) continue;

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

function extractReasoningSummaries(
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
      if (!text) continue;

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
    new Set([
      "started_at",
      "start_time",
      "created_at",
      "createdat",
      "requested_at",
      "timestamp",
    ]),
  );
  const providerCompletedAt = findTimestamp(
    outputItem,
    new Set([
      "completed_at",
      "finished_at",
      "ended_at",
      "updated_at",
      "completedat",
      "finishedat",
    ]),
  );

  return {
    outputIndex,
    providerToolCallId: readString(outputItem["id"]),
    toolType: type,
    status: readString(outputItem["status"]),
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
  const outputItems = Array.isArray(responseRecord["output"])
    ? responseRecord["output"]
    : [];

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

function aggregateUsage(
  usages: (InvestigatorUsageAudit | null)[],
): InvestigatorUsageAudit | null {
  const presentUsages = usages.filter(
    (usage): usage is InvestigatorUsageAudit => usage !== null,
  );
  if (presentUsages.length === 0) return null;

  return presentUsages.reduce<InvestigatorUsageAudit>(
    (accumulator, usage) => ({
      inputTokens: accumulator.inputTokens + usage.inputTokens,
      outputTokens: accumulator.outputTokens + usage.outputTokens,
      totalTokens: accumulator.totalTokens + usage.totalTokens,
      cachedInputTokens:
        (accumulator.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
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
  return {
    responseId: finalAudit.responseId,
    responseStatus: finalAudit.responseStatus,
    responseModelVersion: finalAudit.responseModelVersion,
    responseOutputText: finalAudit.responseOutputText,
    outputItems: responseAudits.flatMap((audit) => audit.outputItems),
    outputTextParts: responseAudits.flatMap((audit) => audit.outputTextParts),
    outputTextAnnotations: responseAudits.flatMap(
      (audit) => audit.outputTextAnnotations,
    ),
    reasoningSummaries: responseAudits.flatMap((audit) => audit.reasoningSummaries),
    toolCalls: responseAudits.flatMap((audit) => audit.toolCalls),
    usage: aggregateUsage(responseAudits.map((audit) => audit.usage)),
  };
}

function extractPendingFunctionToolCalls(
  responseRecord: Record<string, unknown>,
): PendingFunctionToolCall[] {
  const outputItems = Array.isArray(responseRecord["output"])
    ? responseRecord["output"]
    : [];

  const calls: PendingFunctionToolCall[] = [];
  for (const outputItem of outputItems) {
    if (!isRecord(outputItem) || outputItem["type"] !== "function_call") continue;

    const callId = readString(outputItem["call_id"]);
    const name = readString(outputItem["name"]);
    const argumentsJson = readString(outputItem["arguments"]);
    if (!callId || !name || argumentsJson === null) continue;

    calls.push({ callId, name, argumentsJson });
  }

  return calls;
}

function deduplicateFunctionToolCalls(
  calls: PendingFunctionToolCall[],
): PendingFunctionToolCall[] {
  const deduplicated: PendingFunctionToolCall[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.callId)) continue;
    seen.add(call.callId);
    deduplicated.push(call);
  }
  return deduplicated;
}

async function executeFunctionToolCall(
  call: PendingFunctionToolCall,
): Promise<FunctionCallOutput> {
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
  readonly cause: unknown;

  constructor(message: string, attemptAudit: InvestigatorAttemptAudit, cause?: unknown) {
    super(message);
    this.name = "InvestigatorExecutionError";
    this.attemptAudit = attemptAudit;
    this.cause = cause;
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
    const userPrompt = buildUserPrompt({
      contentText: input.contentText,
      platform: input.platform,
      url: input.url,
      authorName: input.authorName,
      postPublishedAt: input.postPublishedAt,
      hasVideo: input.hasVideo,
    });
    const initialInput = buildInitialInput(userPrompt, input.imageUrls);
    const client = this.client;

    const requestedTools = [
      { type: "web_search_preview" as const },
      fetchUrlToolDefinition,
    ];
    const requestReasoning = {
      effort: DEFAULT_REASONING_EFFORT as "low" | "medium" | "high",
      summary: DEFAULT_REASONING_SUMMARY as "auto" | "concise" | "detailed",
    };

    const baseResponseRequest = {
      model: OPENAI_MODEL_ID,
      stream: false as const,
      instructions: INVESTIGATION_SYSTEM_PROMPT,
      tools: requestedTools,
      reasoning: requestReasoning,
      text: {
        format: {
          type: "json_schema" as const,
          name: "investigation_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              claims: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    context: { type: "string" },
                    summary: { type: "string" },
                    reasoning: { type: "string" },
                    sources: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          url: { type: "string" },
                          title: { type: "string" },
                          snippet: { type: "string" },
                        },
                        required: ["url", "title", "snippet"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: [
                    "text",
                    "context",
                    "summary",
                    "reasoning",
                    "sources",
                  ],
                  additionalProperties: false,
                },
              },
            },
            required: ["claims"],
            additionalProperties: false,
          },
        },
      },
    };

    const startedAt = new Date().toISOString();
    const baseAttemptAudit: InvestigatorAttemptAudit = {
      startedAt,
      completedAt: null,
      requestModel: OPENAI_MODEL_ID,
      requestInstructions: INVESTIGATION_SYSTEM_PROMPT,
      requestInput: userPrompt,
      requestReasoningEffort: requestReasoning.effort,
      requestReasoningSummary: requestReasoning.summary,
      requestedTools: extractRequestedTools(requestedTools),
      response: null,
      error: null,
    };

    let outputIndexOffset = 0;
    let previousResponseId: string | null = null;
    let latestResponseRecord: Record<string, unknown> | null = null;
    let nextInput: string | ResponseInput | FunctionCallOutput[] = initialInput;
    const responseAudits: InvestigatorResponseAudit[] = [];

    let round = 0;
    while (MAX_RESPONSE_TOOL_ROUNDS === undefined || round < MAX_RESPONSE_TOOL_ROUNDS) {
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
          ...baseAttemptAudit,
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

      if (!previousResponseId) {
        const cause = new InvestigatorStructuredOutputError(
          "Tool calls were emitted without a response id",
        );
        throw new InvestigatorExecutionError(
          cause.message,
          parseInvestigatorAttemptAudit({
            ...baseAttemptAudit,
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
      const cause = new InvestigatorStructuredOutputError(
        "Model returned no response payload",
      );
      throw new InvestigatorExecutionError(
        cause.message,
        parseInvestigatorAttemptAudit({
          ...baseAttemptAudit,
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
        MAX_RESPONSE_TOOL_ROUNDS === undefined
          ? "Model returned unfinished tool calls after an unbounded tool loop"
          : `Model exceeded tool call round limit (${MAX_RESPONSE_TOOL_ROUNDS.toString()})`,
      );
      throw new InvestigatorExecutionError(
        cause.message,
        parseInvestigatorAttemptAudit({
          ...baseAttemptAudit,
          completedAt: new Date().toISOString(),
          response: mergeResponseAudits(responseAudits),
          error: buildErrorAudit(cause),
        }),
        cause,
      );
    }

    const responseAudit = mergeResponseAudits(responseAudits);
    const completedAt = new Date().toISOString();

    const attemptAudit = parseInvestigatorAttemptAudit({
      ...baseAttemptAudit,
      completedAt,
      response: responseAudit,
      error: null,
    });

    if (responseAudit.responseStatus !== "completed") {
      const incompleteReason = readIncompleteReason(latestResponseRecord);
      const cause = new InvestigatorIncompleteResponseError(
        {
          responseStatus: responseAudit.responseStatus,
          responseId: responseAudit.responseId,
          incompleteReason,
          outputTextLength: responseAudit.responseOutputText?.length ?? 0,
        },
      );
      throw new InvestigatorExecutionError(
        "OpenAI response was incomplete before structured output parsing",
        parseInvestigatorAttemptAudit({
          ...attemptAudit,
          error: buildErrorAudit(cause),
        }),
        cause,
      );
    }

    const outputText = responseAudit.responseOutputText ?? "";
    if (outputText.trim().length === 0) {
      const cause = new InvestigatorStructuredOutputError(
        "Model returned empty structured output",
      );
      throw new InvestigatorExecutionError(
        cause.message,
        parseInvestigatorAttemptAudit({
          ...attemptAudit,
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
          ...attemptAudit,
          error: buildErrorAudit(error),
        }),
        error,
      );
    }

    try {
      const result = investigationResultSchema.parse(parsed);

      return {
        result,
        attemptAudit,
        modelVersion: responseAudit.responseModelVersion ?? undefined,
      };
    } catch (error) {
      throw new InvestigatorExecutionError(
        "Model returned structured output that failed schema validation",
        parseInvestigatorAttemptAudit({
          ...attemptAudit,
          error: buildErrorAudit(error),
        }),
        error,
      );
    }
  }
}
