import type { SettingsValidationOutput } from "@openerrata/shared";
import {
  openaiApiKeyFormatSchema,
  OPENAI_KEY_VALIDATION_TIMEOUT_MS,
} from "@openerrata/shared";
import OpenAI from "openai";
import {
  classifyOpenAiKeyValidationStatus,
  readOpenAiStatusCode,
} from "$lib/openai/errors.js";

type OpenAiKeyValidationStatusOutcome = Omit<
  SettingsValidationOutput,
  "instanceApiKeyAccepted"
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

function readErrorMessage(error: unknown): string | null {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : null;
}

export async function validateOpenAiApiKeyForSettings(
  openaiApiKey: string | null,
): Promise<OpenAiKeyValidationStatusOutcome> {
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

    const statusOutcome = classifyOpenAiKeyValidationStatus(
      readOpenAiStatusCode(error),
    );
    if (statusOutcome) {
      return statusOutcome;
    }

    return {
      openaiApiKeyStatus: "error",
      openaiApiKeyMessage:
        readErrorMessage(error) ??
        "Could not validate this key with OpenAI. Check outbound network access and retry.",
    };
  }
}
