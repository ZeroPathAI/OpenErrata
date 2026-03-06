import { OPENAI_KEY_VALIDATION_TIMEOUT_MS } from "@openerrata/shared";
import OpenAI from "openai";
import { getEnv } from "$lib/config/env.js";
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
    await client.responses.create(
      {
        model: getEnv().OPENAI_MODEL_ID,
        input: "Reply with the single word pong.",
        max_output_tokens: 16,
      },
      { signal: abortController.signal },
    );
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
