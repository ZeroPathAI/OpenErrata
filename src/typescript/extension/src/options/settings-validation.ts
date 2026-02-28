import {
  EXTENSION_TRPC_PATH,
  isNonNullObject,
  openaiApiKeyFormatSchema,
  OPENAI_KEY_VALIDATION_TIMEOUT_MS,
  settingsValidationOutputSchema,
  type SettingsValidationOutput,
} from "@openerrata/shared";
import {
  TRPCClientError,
  createTRPCUntypedClient,
  httpLink,
  type TRPCUntypedClient,
} from "@trpc/client";
import {
  API_BASE_URL_REQUIREMENTS_MESSAGE,
  apiEndpointUrl,
  normalizeApiBaseUrl,
  normalizeOpenaiApiKey,
} from "../lib/settings.js";
import { describeError } from "../lib/describe-error.js";
import { EXTENSION_VERSION_HEADER_NAME } from "../background/api-client-core.js";
import { EXTENSION_VERSION } from "../lib/extension-version.js";

const SETTINGS_PROBE_TIMEOUT_MS = OPENAI_KEY_VALIDATION_TIMEOUT_MS + 1_000;

type TrpcClient = TRPCUntypedClient<never>;

interface SettingsProbeInput {
  apiBaseUrl: string;
  apiKey: string;
  openaiApiKey: string;
}

type SettingsProbeResult =
  | { status: "ok"; validation: SettingsValidationOutput }
  | { status: "error"; message: string };

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const forwardAbort = (): void => {
    controller.abort();
  };
  const timeoutId = setTimeout(forwardAbort, SETTINGS_PROBE_TIMEOUT_MS);

  if (init.signal?.aborted) {
    controller.abort();
  } else {
    init.signal?.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
    init.signal?.removeEventListener("abort", forwardAbort);
  }
}

async function checkHealthEndpoint(apiBaseUrl: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(apiEndpointUrl(apiBaseUrl, "health"), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return `Health check failed (HTTP ${response.status.toString()}).`;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return "Health check response was not valid JSON.";
    }

    if (!isNonNullObject(payload) || payload["status"] !== "ok") {
      return "Health check response did not match the OpenErrata API contract.";
    }

    return null;
  } catch (error) {
    if (isAbortError(error)) {
      return "Health check timed out. Confirm the API server is running and reachable.";
    }

    return `Could not reach API health endpoint: ${describeError(error)}`;
  }
}

function createSettingsProbeClient(input: {
  apiBaseUrl: string;
  apiKey: string;
  openaiApiKey: string;
}): TrpcClient {
  const client = createTRPCUntypedClient({
    links: [
      httpLink({
        url: apiEndpointUrl(input.apiBaseUrl, "trpc"),
        fetch: (url, init) => {
          const headers = new Headers(init?.headers);
          const normalizedApiKey = input.apiKey.trim();
          if (normalizedApiKey.length > 0) {
            headers.set("x-api-key", normalizedApiKey);
          }

          const normalizedOpenaiApiKey = normalizeOpenaiApiKey(input.openaiApiKey);
          if (normalizedOpenaiApiKey.length > 0) {
            headers.set("x-openai-api-key", normalizedOpenaiApiKey);
          }
          if (EXTENSION_VERSION.length > 0) {
            headers.set(EXTENSION_VERSION_HEADER_NAME, EXTENSION_VERSION);
          }

          const requestInit: RequestInit = { headers };
          if (init?.method !== undefined) {
            requestInit.method = init.method;
          }
          if (init?.body !== undefined) {
            requestInit.body = init.body;
          }
          if (init?.signal !== undefined) {
            requestInit.signal = init.signal;
          }

          return fetchWithTimeout(url, requestInit);
        },
      }),
    ],
  });

  return client;
}

function isMissingProcedureError(error: Error): boolean {
  if (!("data" in error)) {
    return false;
  }
  const data: unknown = error.data;
  return isNonNullObject(data) && data["code"] === "NOT_FOUND";
}

export function getOpenaiApiKeyFormatError(rawOpenaiApiKey: string): string | null {
  const normalizedOpenaiApiKey = normalizeOpenaiApiKey(rawOpenaiApiKey);
  if (normalizedOpenaiApiKey.length === 0) return null;

  return openaiApiKeyFormatSchema.safeParse(normalizedOpenaiApiKey).success
    ? null
    : "OpenAI API key must start with sk- and include the full token.";
}

export async function probeSettingsConfiguration(
  input: SettingsProbeInput,
): Promise<SettingsProbeResult> {
  const normalizedApiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  if (normalizedApiBaseUrl === null) {
    return {
      status: "error",
      message: API_BASE_URL_REQUIREMENTS_MESSAGE,
    };
  }

  const healthError = await checkHealthEndpoint(normalizedApiBaseUrl);
  if (healthError !== null) {
    return { status: "error", message: healthError };
  }

  const client = createSettingsProbeClient({
    apiBaseUrl: normalizedApiBaseUrl,
    apiKey: input.apiKey,
    openaiApiKey: input.openaiApiKey,
  });

  try {
    const response = await client.query(EXTENSION_TRPC_PATH.VALIDATE_SETTINGS, undefined);
    const parsed = settingsValidationOutputSchema.safeParse(response);

    if (!parsed.success) {
      return {
        status: "error",
        message: "Validation response did not match the OpenErrata API contract.",
      };
    }

    return {
      status: "ok",
      validation: parsed.data,
    };
  } catch (error) {
    if (error instanceof TRPCClientError && isMissingProcedureError(error)) {
      return {
        status: "error",
        message: `Server is reachable but missing ${EXTENSION_TRPC_PATH.VALIDATE_SETTINGS}. Confirm this is the OpenErrata API server.`,
      };
    }

    if (isAbortError(error)) {
      return {
        status: "error",
        message: "Settings validation timed out. Confirm the API server is responsive.",
      };
    }

    return {
      status: "error",
      message: `Settings validation failed: ${describeError(error)}`,
    };
  }
}
