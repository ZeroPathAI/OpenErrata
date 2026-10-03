import { OPENAI_KEY_VALIDATION_TIMEOUT_MS } from "@openerrata/shared";
import OpenAI from "openai";
import {
  validateOpenAiApiKeyForSettingsWithClient,
  type OpenAiKeyValidationStatusOutcome,
} from "./openai-key-validation-core.js";

export async function validateOpenAiApiKeyForSettings(
  openaiApiKey: string | null,
): Promise<OpenAiKeyValidationStatusOutcome> {
  return validateOpenAiApiKeyForSettingsWithClient(
    openaiApiKey,
    // One bounded try: SDK retries would stack further timeouts behind a
    // settings request the user is waiting on.
    (apiKey) => new OpenAI({ apiKey, timeout: OPENAI_KEY_VALIDATION_TIMEOUT_MS, maxRetries: 0 }),
  );
}
