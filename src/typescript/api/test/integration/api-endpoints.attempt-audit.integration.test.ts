import type {
  InvestigatorOutput,
  InvestigatorRequestAudit,
} from "../../src/lib/investigators/interface.js";
import {
  assert,
  orchestrateInvestigation,
  prisma,
  seedInvestigation,
  seedPost,
  test,
  withIntegrationPrefix,
} from "./api-endpoints.integration.shared.js";

const RECEIVED_AT = new Date("2026-10-02T12:00:00.000Z");

function factCheckRound(round: number): InvestigatorRequestAudit {
  return {
    subject: { kind: "FACT_CHECK_ROUND", round },
    model: "gpt-6.1-sol",
    instructions: "fact-check instructions",
    input:
      round === 0
        ? [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Post text" },
                { type: "input_image", detail: "auto", imageContentHash: "hash-image" },
              ],
            },
          ]
        : [{ type: "function_call_output", call_id: "call-1", output: '{"acknowledged":true}' }],
    previousResponseId: round === 0 ? null : "resp_round_0",
    reasoningEffort: "medium",
    reasoningSummary: "detailed",
    include: ["web_search_call.action.sources"],
    tools: [
      { toolType: "web_search", rawDefinition: { type: "web_search" } },
      { toolType: "function", rawDefinition: { type: "function", name: "submit_correction" } },
    ],
    response: {
      providerResponseId: `resp_round_${round.toString()}`,
      status: "completed",
      modelVersion: "gpt-6.1-sol-2026-09-01",
      receivedAt: RECEIVED_AT,
      outputItems:
        round === 0
          ? [
              {
                providerItemId: "rs_1",
                itemType: "reasoning",
                itemStatus: null,
                content: { kind: "REASONING", summaries: ["Check the date.", "Search."] },
              },
              {
                providerItemId: "ws_1",
                itemType: "web_search_call",
                itemStatus: "completed",
                content: {
                  kind: "TOOL_CALL",
                  rawPayload: {
                    type: "web_search_call",
                    id: "ws_1",
                    status: "completed",
                    action: {
                      type: "search",
                      query: "q",
                      sources: [{ type: "url", url: "https://a.example" }],
                    },
                  },
                },
              },
            ]
          : [
              {
                providerItemId: "msg_1",
                itemType: "message",
                itemStatus: "completed",
                content: {
                  kind: "MESSAGE",
                  textParts: [
                    {
                      partType: "output_text",
                      text: "Done, see source.",
                      annotations: [
                        {
                          annotationType: "url_citation",
                          startIndex: 0,
                          endIndex: 4,
                          url: "https://a.example",
                          title: "A",
                          fileId: null,
                        },
                      ],
                    },
                  ],
                },
              },
            ],
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 0,
        reasoningOutputTokens: 10,
      },
    },
  };
}

function claimValidation(claimIndex: number): InvestigatorRequestAudit {
  return {
    subject: { kind: "CLAIM_VALIDATION", claimIndex },
    model: "gpt-6.1-sol",
    instructions: "validation instructions",
    input: `validation prompt ${claimIndex.toString()}`,
    previousResponseId: null,
    reasoningEffort: "medium",
    reasoningSummary: "detailed",
    include: [],
    tools: [],
    response: null,
  };
}

void test("a completed investigation records its model and one audit row per provider request", async () => {
  const post = await seedPost({
    platform: "X",
    externalId: "attempt-audit-requests-1",
    url: "https://x.com/openerrata/status/attempt-audit-requests-1",
    contentText: "Every provider request gets its own audit row.",
  });
  const investigation = await seedInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
    status: "PENDING",
    promptLabel: "attempt-audit-requests",
  });
  const output: InvestigatorOutput = {
    result: { claims: [] },
    attemptAudit: {
      outcome: "SUCCEEDED",
      startedAt: RECEIVED_AT,
      completedAt: RECEIVED_AT,
      requests: [factCheckRound(0), factCheckRound(1), claimValidation(0)],
    },
    model: "gpt-6.1-sol",
    modelVersion: "gpt-6.1-sol-2026-09-01",
  };

  await orchestrateInvestigation(
    investigation.id,
    { info() {}, warn() {}, error() {} },
    {
      workerIdentity: withIntegrationPrefix("worker-attempt-audit"),
      createInvestigator: () => ({ investigate: async () => output }),
    },
  );

  const stored = await prisma.investigation.findUniqueOrThrow({
    where: { id: investigation.id },
    select: { status: true, model: true, modelVersion: true },
  });
  assert.deepEqual(stored, {
    status: "COMPLETE",
    model: "gpt-6.1-sol",
    modelVersion: "gpt-6.1-sol-2026-09-01",
  });

  const attempt = await prisma.investigationAttempt.findFirstOrThrow({
    where: { investigationId: investigation.id },
    include: {
      error: true,
      requests: {
        // Enum order: FACT_CHECK_ROUND before CLAIM_VALIDATION.
        orderBy: [{ kind: "asc" }, { factCheckRound: "asc" }, { claimIndex: "asc" }],
        include: {
          requestedTools: { orderBy: { requestOrder: "asc" } },
          response: {
            include: {
              usage: true,
              outputItems: {
                orderBy: { outputIndex: "asc" },
                include: {
                  textParts: { include: { annotations: true } },
                  reasoningSummaries: { orderBy: { summaryIndex: "asc" } },
                  toolCall: true,
                },
              },
            },
          },
        },
      },
    },
  });
  assert.equal(attempt.outcome, "SUCCEEDED");
  assert.equal(attempt.error, null);

  assert.deepEqual(
    attempt.requests.map((request) => [request.kind, request.factCheckRound, request.claimIndex]),
    [
      ["FACT_CHECK_ROUND", 0, null],
      ["FACT_CHECK_ROUND", 1, null],
      ["CLAIM_VALIDATION", null, 0],
    ],
  );
  const [round0, round1, validation] = attempt.requests;
  assert.ok(validation && round0 && round1);
  assert.equal(validation.response, null);
  assert.equal(validation.input, "validation prompt 0");
  assert.deepEqual(validation.include, []);

  assert.deepEqual(round0.input, factCheckRound(0).input);
  assert.equal(round0.previousResponseId, null);
  assert.equal(round1.previousResponseId, "resp_round_0");
  assert.deepEqual(round0.include, ["web_search_call.action.sources"]);
  assert.deepEqual(
    round0.requestedTools.map((tool) => [tool.requestOrder, tool.toolType]),
    [
      [0, "web_search"],
      [1, "function"],
    ],
  );

  assert.ok(round0.response);
  assert.equal(round0.response.providerResponseId, "resp_round_0");
  assert.equal(round0.response.receivedAt?.toISOString(), RECEIVED_AT.toISOString());
  assert.equal(round0.response.usage?.totalTokens, 120);
  const [reasoning, webSearch] = round0.response.outputItems;
  assert.ok(reasoning && webSearch);
  assert.equal(reasoning.providerItemId, "rs_1");
  assert.equal(reasoning.itemStatus, null);
  assert.deepEqual(
    reasoning.reasoningSummaries.map((summary) => summary.text),
    ["Check the date.", "Search."],
  );
  assert.ok(webSearch.toolCall);
  assert.deepEqual(webSearch.toolCall.rawPayload, {
    type: "web_search_call",
    id: "ws_1",
    status: "completed",
    action: { type: "search", query: "q", sources: [{ type: "url", url: "https://a.example" }] },
  });

  const [message] = round1.response?.outputItems ?? [];
  assert.equal(message?.textParts[0]?.text, "Done, see source.");
  assert.equal(message.textParts[0].annotations[0]?.url, "https://a.example");
});

void test("the database rejects a COMPLETE investigation without a recorded model", async () => {
  const post = await seedPost({
    platform: "X",
    externalId: "attempt-audit-model-check-1",
    url: "https://x.com/openerrata/status/attempt-audit-model-check-1",
    contentText: "COMPLETE requires a model.",
  });
  const investigation = await seedInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
    status: "PENDING",
    promptLabel: "attempt-audit-model-check",
  });

  await assert.rejects(
    prisma.investigation.update({
      where: { id: investigation.id },
      data: { status: "COMPLETE", checkedAt: new Date() },
    }),
    /Investigation_model_consistency_check/,
  );
  await assert.rejects(
    prisma.investigation.update({
      where: { id: investigation.id },
      data: { model: "gpt-6.1-sol" },
    }),
    /Investigation_model_consistency_check/,
  );
});

void test("the database rejects an attempt request whose subject does not match its kind", async () => {
  const post = await seedPost({
    platform: "X",
    externalId: "attempt-audit-subject-check-1",
    url: "https://x.com/openerrata/status/attempt-audit-subject-check-1",
    contentText: "Request subjects must match their kind.",
  });
  const investigation = await seedInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
    status: "FAILED",
    promptLabel: "attempt-audit-subject-check",
  });
  const attempt = await prisma.investigationAttempt.create({
    data: {
      investigationId: investigation.id,
      attemptNumber: 1,
      outcome: "FAILED",
      startedAt: new Date(),
      completedAt: new Date(),
    },
  });

  const request = {
    attemptId: attempt.id,
    model: "gpt-6.1-sol",
    instructions: "instructions",
    input: "input",
    include: [],
  };
  for (const subject of [
    { kind: "FACT_CHECK_ROUND" as const, factCheckRound: null, claimIndex: null },
    { kind: "FACT_CHECK_ROUND" as const, factCheckRound: 0, claimIndex: 0 },
    { kind: "CLAIM_VALIDATION" as const, factCheckRound: 0, claimIndex: null },
    { kind: "LEGACY_COMBINED" as const, factCheckRound: 0, claimIndex: null },
  ]) {
    await assert.rejects(
      prisma.investigationAttemptRequest.create({ data: { ...request, ...subject } }),
      /InvestigationAttemptRequest_subject_check/,
      JSON.stringify(subject),
    );
  }
});
