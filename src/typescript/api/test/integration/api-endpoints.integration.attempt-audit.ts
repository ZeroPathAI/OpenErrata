import type {
  InvestigatorFailedAttemptAudit,
  InvestigatorOutput,
  InvestigatorRequestAudit,
  InvestigatorSucceededAttemptAudit,
} from "../../src/lib/investigators/interface.js";

function buildFactCheckRequestAudit(label: string): InvestigatorRequestAudit {
  return {
    subject: { kind: "FACT_CHECK_ROUND", round: 0 },
    model: "gpt-6.1-sol",
    instructions: `instructions-${label}`,
    input: `input-${label}`,
    previousResponseId: null,
    reasoningEffort: "medium",
    reasoningSummary: "detailed",
    include: ["web_search_call.action.sources"],
    tools: [{ toolType: "web_search", rawDefinition: { type: "web_search" } }],
    response: {
      providerResponseId: `response-${label}`,
      status: "completed",
      modelVersion: "test-model-version",
      receivedAt: new Date(),
      outputItems: [
        {
          providerItemId: `msg-${label}`,
          itemType: "message",
          itemStatus: "completed",
          content: {
            kind: "MESSAGE",
            textParts: [{ partType: "output_text", text: "No issues found.", annotations: [] }],
          },
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cachedInputTokens: 0,
        reasoningOutputTokens: 2,
      },
    },
  };
}

export function buildSucceededAttemptAudit(label: string): InvestigatorSucceededAttemptAudit {
  const now = new Date();
  return {
    outcome: "SUCCEEDED",
    startedAt: now,
    completedAt: now,
    requests: [buildFactCheckRequestAudit(label)],
  };
}

export function buildFailedAttemptAudit(label: string): InvestigatorFailedAttemptAudit {
  const now = new Date();
  return {
    outcome: "FAILED",
    startedAt: now,
    completedAt: now,
    requests: [{ ...buildFactCheckRequestAudit(label), response: null }],
    error: {
      errorName: "TransientTestFailure",
      errorMessage: `transient-error-${label}`,
      statusCode: null,
    },
  };
}

/** A successful investigator result with no claims, as the fake investigators return it. */
export function buildSucceededInvestigatorOutput(label: string): InvestigatorOutput {
  return {
    result: { claims: [] },
    attemptAudit: buildSucceededAttemptAudit(label),
    model: "gpt-6.1-sol",
    modelVersion: "test-model-version",
  };
}
