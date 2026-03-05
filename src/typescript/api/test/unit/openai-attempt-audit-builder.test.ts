import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFailedAttemptAudit,
  buildFullAttemptResponseAudit,
  buildSuccessfulAttemptAudit,
  createStageOneAttemptAuditBase,
  createStageTwoAttemptAuditBase,
} from "../../src/lib/investigators/openai-attempt-audit-builder.js";
import type { InvestigatorResponseAudit } from "../../src/lib/investigators/interface.js";

function makeResponseAudit(input: {
  responseId: string;
  outputCount: number;
}): InvestigatorResponseAudit {
  return {
    responseId: input.responseId,
    responseStatus: "completed",
    responseModelVersion: "test-model",
    responseOutputText: null,
    outputItems: Array.from({ length: input.outputCount }, (_, index) => ({
      outputIndex: index,
      providerItemId: `item-${index.toString()}`,
      itemType: "message",
      itemStatus: "completed",
    })),
    outputTextParts: [],
    outputTextAnnotations: [],
    reasoningSummaries: [],
    toolCalls: [],
    usage: null,
  };
}

test("attempt audit builders construct stage-one and stage-two request metadata", () => {
  const stageOne = createStageOneAttemptAuditBase({
    startedAt: "2026-01-01T00:00:00.000Z",
    openAiModelId: "test-model",
    systemPrompt: "fact-check prompt",
    userPrompt: "user prompt",
    requestReasoning: {
      effort: "medium",
      summary: "detailed",
    },
    requestedTools: [{ type: "web_search_preview" }],
  });

  const stageTwo = createStageTwoAttemptAuditBase({
    stageOneBase: stageOne,
    userPrompt: "user prompt",
    validationInputSummary: "Claim 0: approved",
  });

  assert.match(stageTwo.requestInstructions, /Stage 1/);
  assert.match(stageTwo.requestInstructions, /Stage 2/);
  assert.match(stageTwo.requestInput, /Claim 0: approved/);
});

test("buildFullAttemptResponseAudit offsets validation output indices", () => {
  const factCheck = makeResponseAudit({ responseId: "resp-stage1", outputCount: 2 });
  const validationA = makeResponseAudit({ responseId: "resp-val-a", outputCount: 1 });
  const validationB = makeResponseAudit({ responseId: "resp-val-b", outputCount: 1 });

  const merged = buildFullAttemptResponseAudit({
    factCheckResponseAudit: factCheck,
    successfulValidationResponseAudits: [validationA],
    failedValidationResponseAudits: [validationB],
  });

  assert.equal(merged.outputItems.length, 4);
  assert.deepEqual(
    merged.outputItems.map((item) => item.outputIndex),
    [0, 1, 2, 3],
  );
});

test("buildFailedAttemptAudit and buildSuccessfulAttemptAudit set terminal fields", () => {
  const base = createStageOneAttemptAuditBase({
    startedAt: "2026-01-01T00:00:00.000Z",
    openAiModelId: "test-model",
    systemPrompt: "prompt",
    userPrompt: "user",
    requestReasoning: {
      effort: "medium",
      summary: "detailed",
    },
    requestedTools: [],
  });

  const response = makeResponseAudit({ responseId: "resp-stage1", outputCount: 1 });

  const failed = buildFailedAttemptAudit({
    base,
    response,
    error: new Error("boom"),
    completedAt: "2026-01-01T00:00:01.000Z",
  });
  assert.notEqual(failed.error, null);
  assert.equal(failed.completedAt, "2026-01-01T00:00:01.000Z");

  const succeeded = buildSuccessfulAttemptAudit({
    base,
    response,
    completedAt: "2026-01-01T00:00:02.000Z",
  });
  assert.equal(succeeded.error, null);
  assert.equal(succeeded.completedAt, "2026-01-01T00:00:02.000Z");
});
