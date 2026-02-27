import { openaiApiKeyFormatSchema } from "@openerrata/shared";
import { classifyOpenAiKeyValidationStatus, readOpenAiStatusCode } from "$lib/openai/errors.js";

export type OpenAiKeyValidationStatusOutcome =
  | { openaiApiKeyStatus: "missing" }
  | { openaiApiKeyStatus: "valid" }
  | {
      openaiApiKeyStatus: "format_invalid";
      openaiApiKeyMessage: string;
    }
  | {
      openaiApiKeyStatus: "authenticated_restricted";
      openaiApiKeyMessage: string;
    }
  | {
      openaiApiKeyStatus: "invalid";
      openaiApiKeyMessage: string;
    }
  | {
      openaiApiKeyStatus: "error";
      openaiApiKeyMessage: string;
    };

type ValidateOpenAiKeyReachability = (openAiApiKey: string) => Promise<void>;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function readErrorMessage(error: unknown): string | null {
  return error instanceof Error && error.message.trim().length > 0 ? error.message.trim() : null;
}

export async function validateOpenAiApiKeyForSettingsWithReachability(
  openaiApiKey: string | null,
  validateOpenAiApiKeyReachability: ValidateOpenAiKeyReachability,
): Promise<OpenAiKeyValidationStatusOutcome> {
  const normalizedOpenAiApiKey = openaiApiKey?.trim() ?? "";
  if (normalizedOpenAiApiKey.length === 0) {
    return { openaiApiKeyStatus: "missing" };
  }

  const formatResult = openaiApiKeyFormatSchema.safeParse(normalizedOpenAiApiKey);
  if (!formatResult.success) {
    return {
      openaiApiKeyStatus: "format_invalid",
      openaiApiKeyMessage: "OpenAI API keys must begin with sk- and include the full token value.",
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

    const statusOutcome = classifyOpenAiKeyValidationStatus(readOpenAiStatusCode(error));
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
