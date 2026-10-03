import type {
  Response,
  ResponseOutputItem,
  ResponseOutputRefusal,
  ResponseOutputText,
} from "openai/resources/responses/responses";
import { z } from "zod";
import { readOpenAiStatusCode } from "$lib/openai/errors.js";
import type {
  InvestigatorErrorAudit,
  InvestigatorJsonRecord,
  InvestigatorJsonValue,
  InvestigatorOutputItemAudit,
  InvestigatorOutputTextAnnotationAudit,
  InvestigatorOutputTextPartAudit,
  InvestigatorRequestAudit,
  InvestigatorRequestSubject,
  InvestigatorResponseAudit,
} from "./interface.js";
import type { InvestigationRequestParams } from "./openai-request-config.js";

const jsonValueSchema: z.ZodType<InvestigatorJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const jsonRecordSchema = z.record(z.string(), jsonValueSchema);

/**
 * The JSON the SDK puts on (or read off) the wire for an SDK object such as a
 * tool definition or output item, checked to be JSON so it can be stored
 * verbatim. TypeScript's SDK types can't express JSON-ness themselves.
 */
function toJsonRecord(value: object): InvestigatorJsonRecord {
  return jsonRecordSchema.parse(JSON.parse(JSON.stringify(value)));
}

function auditAnnotation(
  annotation: ResponseOutputText["annotations"][number],
): InvestigatorOutputTextAnnotationAudit {
  switch (annotation.type) {
    case "url_citation":
      return {
        annotationType: annotation.type,
        startIndex: annotation.start_index,
        endIndex: annotation.end_index,
        url: annotation.url,
        title: annotation.title,
        fileId: null,
      };
    case "container_file_citation":
      return {
        annotationType: annotation.type,
        startIndex: annotation.start_index,
        endIndex: annotation.end_index,
        url: null,
        title: annotation.filename,
        fileId: annotation.file_id,
      };
    case "file_citation":
      return {
        annotationType: annotation.type,
        startIndex: null,
        endIndex: null,
        url: null,
        title: annotation.filename,
        fileId: annotation.file_id,
      };
    case "file_path":
      return {
        annotationType: annotation.type,
        startIndex: null,
        endIndex: null,
        url: null,
        title: null,
        fileId: annotation.file_id,
      };
  }
}

function auditTextPart(
  part: ResponseOutputText | ResponseOutputRefusal,
): InvestigatorOutputTextPartAudit {
  switch (part.type) {
    case "output_text":
      return {
        partType: part.type,
        text: part.text,
        annotations: part.annotations.map(auditAnnotation),
      };
    case "refusal":
      return { partType: part.type, text: part.refusal, annotations: [] };
  }
}

function auditOutputItem(item: ResponseOutputItem): InvestigatorOutputItemAudit {
  if (item.type === "message") {
    return {
      providerItemId: item.id,
      itemType: item.type,
      itemStatus: item.status,
      content: { kind: "MESSAGE", textParts: item.content.map(auditTextPart) },
    };
  }
  if (item.type === "reasoning") {
    return {
      providerItemId: item.id,
      itemType: item.type,
      itemStatus: item.status ?? null,
      content: { kind: "REASONING", summaries: item.summary.map((summary) => summary.text) },
    };
  }
  // Every other item is a tool call (web_search_call, function_call, …). Their
  // shapes vary by tool and some carry no status, so the item is kept verbatim.
  return {
    providerItemId: item.id ?? null,
    itemType: item.type,
    itemStatus: "status" in item ? (item.status ?? null) : null,
    content: { kind: "TOOL_CALL", rawPayload: toJsonRecord(item) },
  };
}

export function auditResponse(response: Response, receivedAt: Date): InvestigatorResponseAudit {
  return {
    providerResponseId: response.id,
    status: response.status ?? null,
    modelVersion: response.model,
    receivedAt,
    outputItems: response.output.map(auditOutputItem),
    usage:
      response.usage === undefined
        ? null
        : {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            totalTokens: response.usage.total_tokens,
            cachedInputTokens: response.usage.input_tokens_details.cached_tokens,
            reasoningOutputTokens: response.usage.output_tokens_details.reasoning_tokens,
          },
  };
}

/** Audits a request exactly as sent (see InvestigatorRequestAudit.input for images). */
export function auditRequest(input: {
  subject: InvestigatorRequestSubject;
  params: InvestigationRequestParams;
  auditInput: InvestigatorRequestAudit["input"];
  response: InvestigatorResponseAudit | null;
}): InvestigatorRequestAudit {
  const { params } = input;
  return {
    subject: input.subject,
    model: params.model,
    instructions: params.instructions,
    input: input.auditInput,
    previousResponseId: params.previous_response_id ?? null,
    reasoningEffort: params.reasoning.effort ?? null,
    reasoningSummary: params.reasoning.summary ?? null,
    include: [...(params.include ?? [])],
    tools: (params.tools ?? []).map((tool) => ({
      toolType: tool.type,
      rawDefinition: toJsonRecord(tool),
    })),
    response: input.response,
  };
}

export function buildErrorAudit(error: unknown): InvestigatorErrorAudit {
  if (error instanceof Error) {
    return {
      // OpenAI SDK errors keep the generic name "Error"; their class names the failure.
      errorName: error.name === "Error" ? error.constructor.name : error.name,
      errorMessage: error.message,
      statusCode: readOpenAiStatusCode(error),
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: typeof error === "string" ? error : "unknown",
    statusCode: null,
  };
}
