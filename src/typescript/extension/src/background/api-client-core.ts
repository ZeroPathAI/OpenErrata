import type { ExtensionApiProcedurePath } from "@openerrata/shared";
import { EXTENSION_TRPC_PATH } from "@openerrata/shared";
import type { ExtensionSettings } from "../lib/settings-core.js";
import { ApiClientError } from "./api-client-error.js";

export const BUNDLED_ATTESTATION_SECRET = "openerrata-attestation-v1";
export const TRPC_REQUEST_BODY_LIMIT_BYTES = 512 * 1024;
export const EXTENSION_VERSION_HEADER_NAME = "x-openerrata-extension-version";

type ApiClientSettings = Pick<
  ExtensionSettings,
  "apiBaseUrl" | "apiKey" | "openaiApiKey" | "hmacSecret"
>;

interface TrpcFetchInit {
  headers?: HeadersInit;
  method?: string;
  body?: BodyInit | null | undefined;
  signal?: AbortSignal | null | undefined;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function attestationSecretFor(settingsValue: ApiClientSettings): string {
  const configured = settingsValue.hmacSecret.trim();
  return configured.length > 0 ? configured : BUNDLED_ATTESTATION_SECRET;
}

export function clientKeyFor(
  settingsValue: ApiClientSettings,
  includeUserOpenAiHeader: boolean,
): string {
  return [
    settingsValue.apiBaseUrl,
    settingsValue.apiKey.trim(),
    includeUserOpenAiHeader ? settingsValue.openaiApiKey.trim() : "",
    attestationSecretFor(settingsValue),
  ].join("|");
}

export function shouldIncludeUserOpenAiKeyHeader(path: ExtensionApiProcedurePath): boolean {
  return path === EXTENSION_TRPC_PATH.INVESTIGATE_NOW;
}

export async function buildTrpcRequestInit(input: {
  init: TrpcFetchInit | undefined;
  settings: ApiClientSettings;
  includeUserOpenAiHeader: boolean;
  extensionVersion: string;
  computeHmac: (secret: string, body: string) => Promise<string>;
  utf8Length?: (value: string) => number;
}): Promise<RequestInit> {
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

  if (typeof input.init?.body === "string" && input.init.body.length > 0) {
    const bodyBytes = (input.utf8Length ?? utf8ByteLength)(input.init.body);
    if (bodyBytes > TRPC_REQUEST_BODY_LIMIT_BYTES) {
      throw new ApiClientError(
        `tRPC request body too large (${bodyBytes.toString()} bytes > ${TRPC_REQUEST_BODY_LIMIT_BYTES.toString()} bytes)`,
        { errorCode: "PAYLOAD_TOO_LARGE" },
      );
    }
    const signature = await input.computeHmac(
      attestationSecretFor(input.settings),
      input.init.body,
    );
    headers.set("x-openerrata-signature", signature);
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
