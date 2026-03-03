/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
export function buildSucceededAttemptAudit(label: string) {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    completedAt: now,
    requestModel: `test-model-${label}`,
    requestInstructions: `instructions-${label}`,
    requestInput: `input-${label}`,
    requestReasoningEffort: null,
    requestReasoningSummary: null,
    requestedTools: [],
    response: {
      responseId: `response-${label}`,
      responseStatus: "completed",
      responseModelVersion: "test-model-version",
      responseOutputText: '{"claims":[]}',
      outputItems: [],
      outputTextParts: [],
      outputTextAnnotations: [],
      reasoningSummaries: [],
      toolCalls: [],
      usage: null,
    },
    error: null,
  };
}

export function buildFailedAttemptAudit(label: string) {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    completedAt: now,
    requestModel: `test-model-${label}`,
    requestInstructions: `instructions-${label}`,
    requestInput: `input-${label}`,
    requestReasoningEffort: null,
    requestReasoningSummary: null,
    requestedTools: [],
    response: null,
    error: {
      errorName: "TransientTestFailure",
      errorMessage: `transient-error-${label}`,
      statusCode: null,
    },
  };
}
