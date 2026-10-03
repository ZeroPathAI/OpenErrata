import OpenAI from "openai";
import { openaiApiKeyFormatSchema } from "@openerrata/shared";
import { INVESTIGATION_REQUEST_CONFIG } from "$lib/investigators/openai-request-config.js";
import { probeInvestigationRequest } from "$lib/investigators/openai-probe.js";

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

function describeProbeFailure(error: unknown): OpenAiKeyValidationStatusOutcome {
  if (error instanceof OpenAI.AuthenticationError) {
    return { openaiApiKeyStatus: "invalid", openaiApiKeyMessage: "OpenAI rejected this API key." };
  }
  if (error instanceof OpenAI.PermissionDeniedError) {
    return {
      openaiApiKeyStatus: "authenticated_restricted",
      openaiApiKeyMessage:
        "OpenAI authenticated this key, but access is restricted for validation checks.",
    };
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return {
      openaiApiKeyStatus: "error",
      openaiApiKeyMessage:
        "OpenAI key validation timed out. Confirm outbound network access and retry.",
    };
  }
  // Anything else (no model access, rejected request shape, rate limit,
  // network failure) is reported with the provider's own explanation.
  const message = error instanceof Error ? error.message.trim() : "";
  return {
    openaiApiKeyStatus: "error",
    openaiApiKeyMessage:
      message.length > 0
        ? message
        : "Could not validate this key with OpenAI. Check outbound network access and retry.",
  };
}

/**
 * Settings-page key check: the key must be able to make the investigation
 * request itself (same probe the worker runs at startup), so a key without
 * access to the investigation model is not reported as valid.
 */
export async function validateOpenAiApiKeyForSettingsWithClient(
  openaiApiKey: string | null,
  createClient: (apiKey: string) => OpenAI,
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
    await probeInvestigationRequest(
      createClient(normalizedOpenAiApiKey),
      INVESTIGATION_REQUEST_CONFIG,
    );
    return { openaiApiKeyStatus: "valid" };
  } catch (error) {
    return describeProbeFailure(error);
  }
}
