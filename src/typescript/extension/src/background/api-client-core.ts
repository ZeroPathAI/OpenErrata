import type { ExtensionApiProcedurePath } from "@openerrata/shared";
import { EXTENSION_TRPC_PATH } from "@openerrata/shared";
import type { ExtensionSettings } from "../lib/settings-core.js";
import { ApiClientError } from "./api-client-error.js";

export const TRPC_REQUEST_BODY_LIMIT_BYTES = 512 * 1024;
export const EXTENSION_VERSION_HEADER_NAME = "x-openerrata-extension-version";

type ApiClientSettings = Pick<ExtensionSettings, "apiBaseUrl" | "apiKey" | "openaiApiKey">;

interface TrpcFetchInit {
  headers?: HeadersInit;
  method?: string;
  body?: BodyInit | null | undefined;
  signal?: AbortSignal | null | undefined;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Cache key for a tRPC client: every setting its requests depend on. */
export function clientKeyFor(
  settingsValue: ApiClientSettings,
  includeUserOpenAiHeader: boolean,
): string {
  return [
    settingsValue.apiBaseUrl,
    settingsValue.apiKey.trim(),
    includeUserOpenAiHeader ? settingsValue.openaiApiKey.trim() : "",
  ].join("|");
}

export function shouldIncludeUserOpenAiKeyHeader(path: ExtensionApiProcedurePath): boolean {
  return path === EXTENSION_TRPC_PATH.INVESTIGATE_NOW;
}

export function buildTrpcRequestInit(input: {
  init: TrpcFetchInit | undefined;
  settings: ApiClientSettings;
  includeUserOpenAiHeader: boolean;
  extensionVersion: string;
  utf8Length?: (value: string) => number;
}): RequestInit {
  const headers = new Headers(input.init?.headers);
  const apiKey = input.settings.apiKey.trim();
  if (apiKey.length > 0) {
    headers.set("x-api-key", apiKey);
  }
  const userOpenAiApiKey = input.settings.openaiApiKey.trim();
  if (input.includeUserOpenAiHeader && userOpenAiApiKey.length > 0) {
    headers.set("x-openai-api-key", userOpenAiApiKey);
  }
  const trimmedExtensionVersion = input.extensionVersion.trim();
  if (trimmedExtensionVersion.length > 0) {
    headers.set(EXTENSION_VERSION_HEADER_NAME, trimmedExtensionVersion);
  }

  if (typeof input.init?.body === "string") {
    const bodyBytes = (input.utf8Length ?? utf8ByteLength)(input.init.body);
    if (bodyBytes > TRPC_REQUEST_BODY_LIMIT_BYTES) {
      throw new ApiClientError(
        `tRPC request body too large (${bodyBytes.toString()} bytes > ${TRPC_REQUEST_BODY_LIMIT_BYTES.toString()} bytes)`,
        { errorCode: "PAYLOAD_TOO_LARGE" },
      );
    }
  }

  const requestInit: RequestInit = { headers };
  if (input.init?.method !== undefined) {
    requestInit.method = input.init.method;
  }
  if (input.init?.body !== undefined) {
    requestInit.body = input.init.body;
  }
  if (input.init?.signal !== undefined) {
    requestInit.signal = input.init.signal;
  }
  return requestInit;
}

export function assertTrpcResponseAccepted(status: number): void {
  if (status === 413) {
    throw new ApiClientError("tRPC request rejected with HTTP 413 Payload Too Large", {
      errorCode: "PAYLOAD_TOO_LARGE",
    });
  }
}
