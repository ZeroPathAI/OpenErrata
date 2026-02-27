import { OPENAI_KEY_VALIDATION_TIMEOUT_MS } from "@openerrata/shared";
import OpenAI from "openai";
import {
  validateOpenAiApiKeyForSettingsWithReachability,
  type OpenAiKeyValidationStatusOutcome,
} from "./openai-key-validation-core.js";

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

export async function validateOpenAiApiKeyForSettings(
  openaiApiKey: string | null,
): Promise<OpenAiKeyValidationStatusOutcome> {
  return validateOpenAiApiKeyForSettingsWithReachability(
    openaiApiKey,
    validateOpenAiApiKeyReachability,
  );
}
