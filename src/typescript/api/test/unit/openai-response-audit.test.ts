import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import {
  INVESTIGATION_REQUEST_CONFIG,
  buildFactCheckRequestParams,
  buildFactCheckTools,
} from "../../src/lib/investigators/openai-request-config.js";
import {
  auditRequest,
  auditResponse,
  buildErrorAudit,
} from "../../src/lib/investigators/openai-response-audit.js";
import { makeResponse, makeWebSearch } from "../helpers/fake-openai.js";

const RECEIVED_AT = new Date("2026-10-02T12:00:00.000Z");

test("auditResponse nests text parts, citations, summaries and tool payloads under their items", () => {
  const webSearch = makeWebSearch("ws_1", "moon distance", ["https://nasa.gov/moon"]);
  const audit = auditResponse(
    makeResponse({
      id: "resp_1",
      model: "gpt-6.1-sol-2026-09-01",
      output: [
        // Reasoning items carry an id but no status; the id is still recorded.
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Plan." }] },
        webSearch,
        {
          type: "function_call",
          call_id: "call-1",
          name: "fetch_url",
          arguments: "{}",
        },
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "The moon is far.",
              annotations: [
                {
                  type: "url_citation",
                  start_index: 0,
                  end_index: 16,
                  url: "https://nasa.gov/moon",
                  title: "Moon",
                },
              ],
            },
            { type: "refusal", refusal: "No." },
          ],
        },
      ],
    }),
    RECEIVED_AT,
  );

  assert.equal(audit.providerResponseId, "resp_1");
  assert.equal(audit.modelVersion, "gpt-6.1-sol-2026-09-01");
  assert.equal(audit.status, "completed");
  assert.equal(audit.receivedAt, RECEIVED_AT);
  assert.deepEqual(audit.outputItems, [
    {
      providerItemId: "rs_1",
      itemType: "reasoning",
      itemStatus: null,
      content: { kind: "REASONING", summaries: ["Plan."] },
    },
    {
      providerItemId: "ws_1",
      itemType: "web_search_call",
      itemStatus: "completed",
      content: { kind: "TOOL_CALL", rawPayload: JSON.parse(JSON.stringify(webSearch)) },
    },
    {
      providerItemId: null,
      itemType: "function_call",
      itemStatus: null,
      content: {
        kind: "TOOL_CALL",
        rawPayload: {
          type: "function_call",
          call_id: "call-1",
          name: "fetch_url",
          arguments: "{}",
        },
      },
    },
    {
      providerItemId: "msg_1",
      itemType: "message",
      itemStatus: "completed",
      content: {
        kind: "MESSAGE",
        textParts: [
          {
            partType: "output_text",
            text: "The moon is far.",
            annotations: [
              {
                annotationType: "url_citation",
                startIndex: 0,
                endIndex: 16,
                url: "https://nasa.gov/moon",
                title: "Moon",
                fileId: null,
              },
            ],
          },
          { partType: "refusal", text: "No.", annotations: [] },
        ],
      },
    },
  ]);
  assert.deepEqual(audit.usage, {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    cachedInputTokens: 10,
    reasoningOutputTokens: 20,
  });
});

test("auditResponse records a missing status and missing usage as null", () => {
  const {
    usage: _usage,
    status: _status,
    ...withoutUsageOrStatus
  } = makeResponse({ id: "resp_1", output: [] });
  const audit = auditResponse(withoutUsageOrStatus, RECEIVED_AT);
  assert.equal(audit.status, null);
  assert.equal(audit.usage, null);
});

test("auditRequest records the request as sent, with the audit form of its input", () => {
  const params = buildFactCheckRequestParams(INVESTIGATION_REQUEST_CONFIG, {
    instructions: "instructions",
    tools: buildFactCheckTools(null),
    input: [
      { role: "user", content: [{ type: "input_image", detail: "auto", image_url: "data:x" }] },
    ],
    previousResponseId: "resp_0",
  });
  const auditInput = [
    { role: "user", content: [{ type: "input_image", detail: "auto", imageContentHash: "h" }] },
  ];

  const audit = auditRequest({
    subject: { kind: "FACT_CHECK_ROUND", round: 1 },
    params,
    auditInput,
    response: null,
  });

  assert.deepEqual(audit.subject, { kind: "FACT_CHECK_ROUND", round: 1 });
  assert.equal(audit.model, "gpt-6.1-sol");
  assert.equal(audit.instructions, "instructions");
  assert.equal(audit.input, auditInput);
  assert.equal(audit.previousResponseId, "resp_0");
  assert.equal(audit.reasoningEffort, "medium");
  assert.equal(audit.reasoningSummary, "detailed");
  assert.deepEqual(audit.include, ["web_search_call.action.sources"]);
  assert.deepEqual(
    audit.tools.map((tool) => tool.toolType),
    ["web_search", "function", "function"],
  );
  assert.deepEqual(audit.tools[0]?.rawDefinition, { type: "web_search" });
  assert.equal(audit.response, null);
});

test("buildErrorAudit records the HTTP status of OpenAI API errors only", () => {
  const apiError = OpenAI.APIError.generate(
    429,
    { error: { message: "Rate limit reached" } },
    undefined,
    new Headers(),
  );
  assert.deepEqual(buildErrorAudit(apiError), {
    errorName: "RateLimitError",
    errorMessage: "429 Rate limit reached",
    statusCode: 429,
  });

  const lookalike = Object.assign(new Error("not from OpenAI"), { status: 401 });
  assert.equal(buildErrorAudit(lookalike).statusCode, null);
  assert.deepEqual(buildErrorAudit("plain string"), {
    errorName: "UnknownError",
    errorMessage: "plain string",
    statusCode: null,
  });
});
