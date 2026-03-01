import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sanitizeJsonValue,
  sanitizeJsonRecord,
  describeJsonValueType,
  requireJsonObject,
  readString,
  readOptionalInteger,
  readIncompleteReason,
  parseTimestamp,
  findTimestamp,
  extractRequestedTools,
  extractOutputItems,
  extractOutputTextArtifacts,
  extractReasoningSummaries,
  extractToolCalls,
  extractUsage,
  extractResponseAudit,
  offsetResponseAuditIndices,
  aggregateUsage,
  mergeResponseAudits,
  buildErrorAudit,
  requireCompletedOutputText,
} from "../../src/lib/investigators/openai-response-audit.js";
import { InvestigatorStructuredOutputError } from "../../src/lib/investigators/openai.js";
import type { InvestigatorResponseAudit } from "../../src/lib/investigators/interface.js";

// --- sanitizeJsonValue ---

test("sanitizeJsonValue preserves primitives and null", () => {
  assert.equal(sanitizeJsonValue("hello"), "hello");
  assert.equal(sanitizeJsonValue(42), 42);
  assert.equal(sanitizeJsonValue(true), true);
  assert.equal(sanitizeJsonValue(null), null);
});

test("sanitizeJsonValue sanitizes arrays recursively", () => {
  assert.deepStrictEqual(sanitizeJsonValue([1, "two", null]), [1, "two", null]);
});

test("sanitizeJsonValue sanitizes objects recursively", () => {
  assert.deepStrictEqual(sanitizeJsonValue({ a: 1, b: "x" }), { a: 1, b: "x" });
});

test("sanitizeJsonValue converts bigint to string", () => {
  assert.equal(sanitizeJsonValue(123n), "123");
});

test("sanitizeJsonValue converts symbol to description", () => {
  assert.equal(sanitizeJsonValue(Symbol("test")), "test");
});

test("sanitizeJsonValue converts function to placeholder", () => {
  assert.equal(
    sanitizeJsonValue(() => {}),
    "[function]",
  );
});

test("sanitizeJsonValue truncates at max depth", () => {
  assert.equal(sanitizeJsonValue({ nested: true }, 9), "[max-depth]");
});

test("sanitizeJsonValue returns [unsupported] for undefined", () => {
  assert.equal(sanitizeJsonValue(undefined), "[unsupported]");
});

// --- sanitizeJsonRecord ---

test("sanitizeJsonRecord sanitizes object entries", () => {
  const result = sanitizeJsonRecord({ a: 1, b: "two" });
  assert.deepStrictEqual(result, { a: 1, b: "two" });
});

test("sanitizeJsonRecord throws for non-object input", () => {
  assert.throws(() => sanitizeJsonRecord("not an object"), InvestigatorStructuredOutputError);
});

// --- describeJsonValueType ---

test("describeJsonValueType returns correct types", () => {
  assert.equal(describeJsonValueType(null), "null");
  assert.equal(describeJsonValueType([]), "array");
  assert.equal(describeJsonValueType({}), "object");
  assert.equal(describeJsonValueType("str"), "string");
  assert.equal(describeJsonValueType(42), "number");
  assert.equal(describeJsonValueType(true), "boolean");
});

// --- requireJsonObject ---

test("requireJsonObject returns object for valid input", () => {
  const obj = { a: 1 };
  assert.deepStrictEqual(requireJsonObject(obj, "test"), obj);
});

test("requireJsonObject throws for null", () => {
  assert.throws(
    () => requireJsonObject(null, "test"),
    (error: unknown) =>
      error instanceof InvestigatorStructuredOutputError && error.message.includes("null"),
  );
});

test("requireJsonObject throws for array", () => {
  assert.throws(
    () => requireJsonObject([], "test"),
    (error: unknown) =>
      error instanceof InvestigatorStructuredOutputError && error.message.includes("array"),
  );
});

// --- requireCompletedOutputText ---

test("requireCompletedOutputText throws when output text is null", () => {
  assert.throws(
    () =>
      requireCompletedOutputText({
        responseAudit: makeEmptyResponseAudit({ responseOutputText: null }),
        responseRecord: {},
        context: "Test",
      }),
    InvestigatorStructuredOutputError,
  );
});

test("requireCompletedOutputText throws when output text is empty", () => {
  assert.throws(
    () =>
      requireCompletedOutputText({
        responseAudit: makeEmptyResponseAudit({ responseOutputText: "   " }),
        responseRecord: {},
        context: "Test",
      }),
    InvestigatorStructuredOutputError,
  );
});

test("requireCompletedOutputText returns output text when present", () => {
  const text = requireCompletedOutputText({
    responseAudit: makeEmptyResponseAudit({ responseOutputText: '{"claims":[]}' }),
    responseRecord: {},
    context: "Test",
  });
  assert.equal(text, '{"claims":[]}');
});

// --- readString / readOptionalInteger ---

test("readString returns string for string input", () => {
  assert.equal(readString("hello"), "hello");
});

test("readString returns null for non-string input", () => {
  assert.equal(readString(42), null);
  assert.equal(readString(null), null);
  assert.equal(readString(undefined), null);
});

test("readOptionalInteger returns integer for integer input", () => {
  assert.equal(readOptionalInteger(42), 42);
});

test("readOptionalInteger returns null for non-integer", () => {
  assert.equal(readOptionalInteger(3.14), null);
  assert.equal(readOptionalInteger("42"), null);
  assert.equal(readOptionalInteger(null), null);
});

// --- readIncompleteReason ---

test("readIncompleteReason extracts reason from incomplete_details", () => {
  const record = { incomplete_details: { reason: "max_output_tokens" } };
  assert.equal(readIncompleteReason(record), "max_output_tokens");
});

test("readIncompleteReason returns null when incomplete_details is missing", () => {
  assert.equal(readIncompleteReason({}), null);
});

test("readIncompleteReason returns null when reason is not a string", () => {
  assert.equal(readIncompleteReason({ incomplete_details: { reason: 42 } }), null);
});

// --- buildErrorAudit ---

test("buildErrorAudit handles Error instance", () => {
  const error = new TypeError("bad type");
  const audit = buildErrorAudit(error);
  assert.equal(audit.errorName, "TypeError");
  assert.equal(audit.errorMessage, "bad type");
  assert.equal(audit.statusCode, null);
});

test("buildErrorAudit handles string error", () => {
  const audit = buildErrorAudit("string error");
  assert.equal(audit.errorName, "UnknownError");
  assert.equal(audit.errorMessage, "string error");
});

test("buildErrorAudit handles unknown value", () => {
  const audit = buildErrorAudit(42);
  assert.equal(audit.errorName, "UnknownError");
  assert.equal(audit.errorMessage, "unknown");
});

test("buildErrorAudit reads status from error with status property", () => {
  const error = Object.assign(new Error("api error"), { status: 429 });
  const audit = buildErrorAudit(error);
  assert.equal(audit.statusCode, 429);
});

// --- parseTimestamp ---

test("parseTimestamp parses unix seconds", () => {
  const result = parseTimestamp(1700000000);
  assert.ok(result !== null);
  assert.ok(result.includes("2023-11-14"));
});

test("parseTimestamp parses unix milliseconds", () => {
  const result = parseTimestamp(1700000000000);
  assert.ok(result !== null);
  assert.ok(result.includes("2023-11-14"));
});

test("parseTimestamp parses ISO string", () => {
  const result = parseTimestamp("2024-01-15T10:30:00Z");
  assert.ok(result !== null);
  assert.ok(result.includes("2024-01-15"));
});

test("parseTimestamp returns null for empty string", () => {
  assert.equal(parseTimestamp("  "), null);
});

test("parseTimestamp returns null for non-numeric non-string", () => {
  assert.equal(parseTimestamp(null), null);
  assert.equal(parseTimestamp(undefined), null);
  assert.equal(parseTimestamp(true), null);
});

test("parseTimestamp returns null for invalid date string", () => {
  assert.equal(parseTimestamp("not-a-date"), null);
});

test("parseTimestamp returns null for NaN", () => {
  assert.equal(parseTimestamp(NaN), null);
});

test("parseTimestamp returns null for Infinity", () => {
  assert.equal(parseTimestamp(Infinity), null);
});

// --- findTimestamp ---

test("findTimestamp finds timestamp at matching key", () => {
  const value = { created_at: 1700000000 };
  const result = findTimestamp(value, new Set(["created_at"]));
  assert.ok(result !== null);
});

test("findTimestamp finds nested timestamp", () => {
  const value = { outer: { inner: { started_at: "2024-01-01T00:00:00Z" } } };
  const result = findTimestamp(value, new Set(["started_at"]));
  assert.ok(result !== null);
});

test("findTimestamp returns null when no match", () => {
  const result = findTimestamp({ foo: "bar" }, new Set(["started_at"]));
  assert.equal(result, null);
});

test("findTimestamp respects max depth", () => {
  const value = { a: { b: { c: { d: { e: { f: { g: { started_at: 1700000000 } } } } } } } };
  const result = findTimestamp(value, new Set(["started_at"]));
  assert.equal(result, null);
});

test("findTimestamp searches arrays", () => {
  const value = [{ started_at: 1700000000 }];
  const result = findTimestamp(value, new Set(["started_at"]));
  assert.ok(result !== null);
});

// --- extractRequestedTools ---

test("extractRequestedTools extracts tools from array", () => {
  const tools = [{ type: "web_search_preview" }, { type: "function", name: "fetch_url" }];
  const result = extractRequestedTools(tools);
  assert.equal(result.length, 2);
  assert.ok(result[0]);
  assert.equal(result[0].requestOrder, 0);
  assert.equal(result[0].toolType, "web_search_preview");
  assert.ok(result[1]);
  assert.equal(result[1].requestOrder, 1);
  assert.equal(result[1].toolType, "function");
});

test("extractRequestedTools returns empty for non-array", () => {
  assert.deepStrictEqual(extractRequestedTools(null), []);
  assert.deepStrictEqual(extractRequestedTools(undefined), []);
});

test("extractRequestedTools skips non-object entries", () => {
  const tools = ["not-an-object", { type: "function" }];
  const result = extractRequestedTools(tools);
  assert.equal(result.length, 1);
});

// --- extractOutputItems ---

test("extractOutputItems extracts items with id and status", () => {
  const items = [
    { type: "message", id: "msg-1", status: "completed" },
    { type: "function_call", id: "fc-1", status: "completed" },
  ];
  const result = extractOutputItems(items);
  assert.equal(result.length, 2);
  assert.ok(result[0]);
  assert.equal(result[0].providerItemId, "msg-1");
  assert.equal(result[0].itemStatus, "completed");
});

test("extractOutputItems handles missing id by nulling both id and status", () => {
  const items = [{ type: "message", status: "completed" }];
  const result = extractOutputItems(items);
  assert.ok(result[0]);
  assert.equal(result[0].providerItemId, null);
  assert.equal(result[0].itemStatus, null);
});

test("extractOutputItems handles non-object entries", () => {
  const items = ["not-an-object"];
  const result = extractOutputItems(items);
  assert.ok(result[0]);
  assert.equal(result[0].itemType, "unknown");
  assert.equal(result[0].providerItemId, null);
});

// --- extractOutputTextArtifacts ---

test("extractOutputTextArtifacts extracts text parts from message output", () => {
  const items = [
    {
      type: "message",
      content: [{ type: "output_text", text: "Hello world" }],
    },
  ];
  const { parts, annotations } = extractOutputTextArtifacts(items);
  assert.equal(parts.length, 1);
  assert.ok(parts[0]);
  assert.equal(parts[0].text, "Hello world");
  assert.equal(annotations.length, 0);
});

test("extractOutputTextArtifacts extracts annotations", () => {
  const items = [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "See [link]",
          annotations: [
            {
              type: "url_citation",
              start_index: 4,
              end_index: 10,
              url: "https://example.com",
              title: "Example",
            },
          ],
        },
      ],
    },
  ];
  const { parts, annotations } = extractOutputTextArtifacts(items);
  assert.equal(parts.length, 1);
  assert.equal(annotations.length, 1);
  assert.ok(annotations[0]);
  assert.equal(annotations[0].url, "https://example.com");
  assert.deepStrictEqual(annotations[0].characterPosition, { start: 4, end: 10 });
});

test("extractOutputTextArtifacts extracts refusal parts", () => {
  const items = [
    {
      type: "message",
      content: [{ type: "refusal", refusal: "I cannot help with that" }],
    },
  ];
  const { parts } = extractOutputTextArtifacts(items);
  assert.equal(parts.length, 1);
  assert.ok(parts[0]);
  assert.equal(parts[0].partType, "refusal");
  assert.equal(parts[0].text, "I cannot help with that");
});

test("extractOutputTextArtifacts skips non-message output items", () => {
  const items = [{ type: "reasoning", summary: [] }, { type: "function_call" }];
  const { parts } = extractOutputTextArtifacts(items);
  assert.equal(parts.length, 0);
});

// --- extractReasoningSummaries ---

test("extractReasoningSummaries extracts summaries from reasoning items", () => {
  const items = [
    {
      type: "reasoning",
      summary: [{ text: "Step 1 reasoning" }, { text: "Step 2 reasoning" }],
    },
  ];
  const result = extractReasoningSummaries(items);
  assert.equal(result.length, 2);
  assert.ok(result[0]);
  assert.equal(result[0].text, "Step 1 reasoning");
  assert.ok(result[1]);
  assert.equal(result[1].summaryIndex, 1);
});

test("extractReasoningSummaries skips empty text", () => {
  const items = [
    {
      type: "reasoning",
      summary: [{ text: "" }, { text: "valid" }],
    },
  ];
  const result = extractReasoningSummaries(items);
  assert.equal(result.length, 1);
});

// --- extractToolCalls ---

test("extractToolCalls extracts function_call items", () => {
  const items = [
    { type: "message", id: "msg-1", status: "completed" },
    {
      type: "function_call",
      id: "fc-1",
      status: "completed",
      started_at: 1700000000,
      completed_at: 1700000001,
    },
  ];
  const result = extractToolCalls(items);
  assert.equal(result.length, 1);
  assert.ok(result[0]);
  assert.equal(result[0].toolType, "function_call");
  assert.equal(result[0].providerToolCallId, "fc-1");
});

test("extractToolCalls skips message and reasoning types", () => {
  const items = [
    { type: "message", id: "msg-1", status: "completed" },
    { type: "reasoning", id: "r-1", status: "completed" },
  ];
  const result = extractToolCalls(items);
  assert.equal(result.length, 0);
});

// --- extractUsage ---

test("extractUsage extracts usage data", () => {
  const record = {
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens_details: { reasoning_tokens: 10 },
    },
  };
  const result = extractUsage(record);
  assert.ok(result !== null);
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 50);
  assert.equal(result.totalTokens, 150);
  assert.equal(result.cachedInputTokens, 20);
  assert.equal(result.reasoningOutputTokens, 10);
});

test("extractUsage returns null when usage is missing", () => {
  assert.equal(extractUsage({}), null);
});

test("extractUsage returns null when required token fields are missing", () => {
  assert.equal(extractUsage({ usage: { input_tokens: 100 } }), null);
});

// --- extractResponseAudit ---

test("extractResponseAudit extracts a complete audit from response record", () => {
  const record = {
    id: "resp-123",
    status: "completed",
    model: "gpt-4o-2024-08-06",
    output_text: '{"claims":[]}',
    output: [
      {
        type: "message",
        id: "msg-1",
        status: "completed",
        content: [{ type: "output_text", text: '{"claims":[]}' }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  const audit = extractResponseAudit(record);
  assert.equal(audit.responseId, "resp-123");
  assert.equal(audit.responseStatus, "completed");
  assert.equal(audit.responseModelVersion, "gpt-4o-2024-08-06");
  assert.equal(audit.outputItems.length, 1);
  assert.equal(audit.outputTextParts.length, 1);
  assert.ok(audit.usage !== null);
});

test("extractResponseAudit handles empty response record", () => {
  const audit = extractResponseAudit({});
  assert.equal(audit.responseId, null);
  assert.equal(audit.responseStatus, null);
  assert.equal(audit.outputItems.length, 0);
  assert.equal(audit.usage, null);
});

// --- offsetResponseAuditIndices ---

test("offsetResponseAuditIndices returns same audit when offset is 0", () => {
  const audit = makeEmptyResponseAudit();
  assert.strictEqual(offsetResponseAuditIndices(audit, 0), audit);
});

test("offsetResponseAuditIndices offsets all index fields", () => {
  const audit: InvestigatorResponseAudit = {
    ...makeEmptyResponseAudit(),
    outputItems: [{ outputIndex: 0, providerItemId: null, itemType: "message", itemStatus: null }],
    outputTextParts: [{ outputIndex: 0, partIndex: 0, partType: "output_text", text: "hello" }],
    outputTextAnnotations: [
      {
        outputIndex: 0,
        partIndex: 0,
        annotationIndex: 0,
        annotationType: "url_citation",
        url: null,
        title: null,
        fileId: null,
      },
    ],
    reasoningSummaries: [{ outputIndex: 0, summaryIndex: 0, text: "reasoning" }],
    toolCalls: [
      {
        outputIndex: 0,
        providerToolCallId: null,
        toolType: "function_call",
        status: null,
        rawPayload: {},
        capturedAt: new Date().toISOString(),
        providerStartedAt: null,
        providerCompletedAt: null,
      },
    ],
  };

  const offset = offsetResponseAuditIndices(audit, 5);
  assert.ok(offset.outputItems[0]);
  assert.equal(offset.outputItems[0].outputIndex, 5);
  assert.ok(offset.outputTextParts[0]);
  assert.equal(offset.outputTextParts[0].outputIndex, 5);
  assert.ok(offset.outputTextAnnotations[0]);
  assert.equal(offset.outputTextAnnotations[0].outputIndex, 5);
  assert.ok(offset.reasoningSummaries[0]);
  assert.equal(offset.reasoningSummaries[0].outputIndex, 5);
  assert.ok(offset.toolCalls[0]);
  assert.equal(offset.toolCalls[0].outputIndex, 5);
});

// --- aggregateUsage ---

test("aggregateUsage returns null for empty array", () => {
  assert.equal(aggregateUsage([]), null);
});

test("aggregateUsage returns null for all-null array", () => {
  assert.equal(aggregateUsage([null, null]), null);
});

test("aggregateUsage sums token counts", () => {
  const result = aggregateUsage([
    {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 2,
      reasoningOutputTokens: 1,
    },
    {
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      cachedInputTokens: 3,
      reasoningOutputTokens: null,
    },
  ]);
  assert.ok(result !== null);
  assert.equal(result.inputTokens, 30);
  assert.equal(result.outputTokens, 15);
  assert.equal(result.totalTokens, 45);
  assert.equal(result.cachedInputTokens, 5);
  assert.equal(result.reasoningOutputTokens, 1);
});

// --- mergeResponseAudits ---

test("mergeResponseAudits throws for empty array", () => {
  assert.throws(() => mergeResponseAudits([]), /Cannot merge empty response audits/);
});

test("mergeResponseAudits uses final audit metadata and flattens arrays", () => {
  const audit1 = makeEmptyResponseAudit({
    responseId: "resp-1",
    responseStatus: "completed",
    responseModelVersion: "model-1",
  });
  audit1.outputItems = [
    { outputIndex: 0, providerItemId: null, itemType: "message", itemStatus: null },
  ];
  audit1.usage = {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
  };

  const audit2 = makeEmptyResponseAudit({
    responseId: "resp-2",
    responseStatus: "completed",
    responseModelVersion: "model-2",
  });
  audit2.outputItems = [
    { outputIndex: 1, providerItemId: null, itemType: "function_call", itemStatus: null },
  ];
  audit2.usage = {
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
  };

  const merged = mergeResponseAudits([audit1, audit2]);
  assert.equal(merged.responseId, "resp-2");
  assert.equal(merged.responseModelVersion, "model-2");
  assert.equal(merged.outputItems.length, 2);
  assert.ok(merged.usage !== null);
  assert.equal(merged.usage.inputTokens, 30);
});

// --- helpers ---

function makeEmptyResponseAudit(
  overrides?: Partial<InvestigatorResponseAudit>,
): InvestigatorResponseAudit {
  return {
    responseId: null,
    responseStatus: null,
    responseModelVersion: null,
    responseOutputText: null,
    outputItems: [],
    outputTextParts: [],
    outputTextAnnotations: [],
    reasoningSummaries: [],
    toolCalls: [],
    usage: null,
    ...overrides,
  };
}
