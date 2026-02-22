import type { SettingsValidationOutput } from "@openerrata/shared";

const NON_RETRYABLE_OPENAI_STATUS_CODES = new Set([400, 401, 403, 404, 422]);

type OpenAiKeyValidationResult = Pick<
  SettingsValidationOutput,
  "openaiApiKeyStatus" | "openaiApiKeyMessage"
>;

const OPENAI_KEY_VALIDATION_RESULT_BY_STATUS: Partial<
  Record<number, OpenAiKeyValidationResult>
> = {
  401: {
    openaiApiKeyStatus: "invalid",
    openaiApiKeyMessage: "OpenAI rejected this API key.",
  },
  403: {
    openaiApiKeyStatus: "authenticated_restricted",
    openaiApiKeyMessage:
      "OpenAI authenticated this key, but access is restricted for validation checks.",
  },
  429: {
    openaiApiKeyStatus: "error",
    openaiApiKeyMessage: "OpenAI rate-limited key validation. Retry in a moment.",
  },
};

export function readOpenAiStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  if (!("status" in error)) return null;
  const status = error.status;
  return typeof status === "number" ? status : null;
}

export function classifyOpenAiKeyValidationStatus(
  statusCode: number | null,
): OpenAiKeyValidationResult | null {
  if (statusCode === null) return null;

  const knownStatusResult = OPENAI_KEY_VALIDATION_RESULT_BY_STATUS[statusCode];
  if (knownStatusResult !== undefined) {
    return knownStatusResult;
  }

  if (statusCode >= 400 && statusCode < 500) {
    return {
      openaiApiKeyStatus: "error",
      openaiApiKeyMessage:
        `OpenAI returned HTTP ${statusCode.toString()} while validating this key.`,
    };
  }

  return null;
}

export function isNonRetryableOpenAiStatusCode(statusCode: number | null): boolean {
  return statusCode !== null && NON_RETRYABLE_OPENAI_STATUS_CODES.has(statusCode);
}
