import type { SettingsValidationOutput } from "@openerrata/shared";
import {
  openaiApiKeyFormatSchema,
  OPENAI_KEY_VALIDATION_TIMEOUT_MS,
} from "@openerrata/shared";
import OpenAI from "openai";

type OpenAiKeyValidationResult = Pick<
  SettingsValidationOutput,
  "openaiApiKeyStatus" | "openaiApiKeyMessage"
>;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function validateOpenAiApiKeyReachability(openAiApiKey: string): Promise<void> {
  const client = new OpenAI({ apiKey: openAiApiKey });
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, OPENAI_KEY_VALIDATION_TIMEOUT_MS);

  try {
    await client.models.list({ signal: abortController.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function readStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  if (!("status" in error)) return null;
  const status = error.status;
  return typeof status === "number" ? status : null;
}

function readErrorMessage(error: unknown): string | null {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : null;
}

export async function validateOpenAiApiKeyForSettings(
  openaiApiKey: string | null,
): Promise<OpenAiKeyValidationResult> {
  const normalizedOpenAiApiKey = openaiApiKey?.trim() ?? "";
  if (normalizedOpenAiApiKey.length === 0) {
    return { openaiApiKeyStatus: "missing" };
  }

  const formatResult = openaiApiKeyFormatSchema.safeParse(normalizedOpenAiApiKey);
  if (!formatResult.success) {
    return {
      openaiApiKeyStatus: "format_invalid",
      openaiApiKeyMessage:
        "OpenAI API keys must begin with sk- and include the full token value.",
    };
  }

  try {
    await validateOpenAiApiKeyReachability(normalizedOpenAiApiKey);
    return { openaiApiKeyStatus: "valid" };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        openaiApiKeyStatus: "error",
        openaiApiKeyMessage:
          "OpenAI key validation timed out. Confirm outbound network access and retry.",
      };
    }

    const statusCode = readStatusCode(error);
    if (statusCode === 401) {
      return {
        openaiApiKeyStatus: "invalid",
        openaiApiKeyMessage: "OpenAI rejected this API key.",
      };
    }

    if (statusCode === 403) {
      return {
        openaiApiKeyStatus: "authenticated_restricted",
        openaiApiKeyMessage:
          "OpenAI authenticated this key, but access is restricted for validation checks.",
      };
    }

    if (statusCode === 429) {
      return {
        openaiApiKeyStatus: "error",
        openaiApiKeyMessage:
          "OpenAI rate-limited key validation. Retry in a moment.",
      };
    }

    if (statusCode !== null && statusCode >= 400 && statusCode < 500) {
      return {
        openaiApiKeyStatus: "error",
        openaiApiKeyMessage:
          `OpenAI returned HTTP ${statusCode.toString()} while validating this key.`,
      };
    }

    return {
      openaiApiKeyStatus: "error",
      openaiApiKeyMessage:
        readErrorMessage(error) ??
        "Could not validate this key with OpenAI. Check outbound network access and retry.",
    };
  }
}
