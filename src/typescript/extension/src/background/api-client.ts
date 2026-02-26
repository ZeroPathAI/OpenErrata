import type {
  ViewPostInput,
  ViewPostOutput,
  GetInvestigationInput,
  GetInvestigationOutput,
  InvestigateNowOutput,
  ExtensionApiInput,
  ExtensionApiMutationPath,
  ExtensionApiOutput,
  ExtensionApiProcedurePath,
  ExtensionApiQueryPath,
} from "@openerrata/shared";
import {
  EXTENSION_TRPC_PATH,
  getInvestigationOutputSchema,
  investigateNowOutputSchema,
  viewPostOutputSchema,
} from "@openerrata/shared";
import {
  createTRPCUntypedClient,
  httpLink,
  type TRPCUntypedClient,
} from "@trpc/client";
import browser from "webextension-polyfill";
import {
  DEFAULT_EXTENSION_SETTINGS,
  apiEndpointUrl,
  apiHostPermissionFor,
  loadExtensionSettings,
  type ExtensionSettings,
} from "../lib/settings.js";
import { extractApiErrorCode } from "./api-error-code.js";
export { ApiClientError } from "./api-client-error.js";
import { ApiClientError } from "./api-client-error.js";

const BUNDLED_ATTESTATION_SECRET = "openerrata-attestation-v1";
const TRPC_REQUEST_BODY_LIMIT_BYTES = 512 * 1024;

let settings: ExtensionSettings = { ...DEFAULT_EXTENSION_SETTINGS };
let initPromise: Promise<void> | null = null;
let storageListenerRegistered = false;
const cachedClientsByKey = new Map<string, TrpcClient>();

type TrpcClient = TRPCUntypedClient<never>;
type ParsedViewPostOutput = ReturnType<typeof viewPostOutputSchema.parse>;
type ParsedGetInvestigationOutput = ReturnType<
  typeof getInvestigationOutputSchema.parse
>;
type ParsedInvestigateNowOutput = ReturnType<
  typeof investigateNowOutputSchema.parse
>;

async function loadSettingsFromStorage(): Promise<void> {
  settings = await loadExtensionSettings();
}

function registerStorageListener(): void {
  if (storageListenerRegistered) return;
  storageListenerRegistered = true;

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (
      !changes["apiBaseUrl"] &&
      !changes["hmacSecret"] &&
      !changes["apiKey"] &&
      !changes["openaiApiKey"] &&
      !changes["autoInvestigate"]
    ) {
      return;
    }

    cachedClientsByKey.clear();
    void loadSettingsFromStorage().catch((err: unknown) => {
      console.error("Failed to refresh extension settings:", err);
    });
  });
}

export async function init(): Promise<void> {
  initPromise ??= (async () => {
    await loadSettingsFromStorage();
    registerStorageListener();
  })();

  try {
    await initPromise;
  } catch (err) {
    initPromise = null;
    settings = { ...DEFAULT_EXTENSION_SETTINGS };
    cachedClientsByKey.clear();
    console.error("Failed to initialize extension API settings:", err);
  }
}

async function computeHmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );

  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function attestationSecretFor(settingsValue: ExtensionSettings): string {
  const configured = settingsValue.hmacSecret.trim();
  return configured.length > 0 ? configured : BUNDLED_ATTESTATION_SECRET;
}

function clientKeyFor(
  settingsValue: ExtensionSettings,
  includeUserOpenAiHeader: boolean,
): string {
  return [
    settingsValue.apiBaseUrl,
    settingsValue.apiKey.trim(),
    includeUserOpenAiHeader ? settingsValue.openaiApiKey.trim() : "",
    attestationSecretFor(settingsValue),
  ].join("|");
}

function shouldIncludeUserOpenAiKeyHeader(
  path: ExtensionApiProcedurePath,
): boolean {
  return path === EXTENSION_TRPC_PATH.INVESTIGATE_NOW;
}

function getOrCreateTrpcClient(options: {
  includeUserOpenAiHeader: boolean;
}): TrpcClient {
  const key = clientKeyFor(settings, options.includeUserOpenAiHeader);
  const cachedClient = cachedClientsByKey.get(key);
  if (cachedClient) {
    return cachedClient;
  }

  const client = createTRPCUntypedClient({
    links: [
      httpLink({
        url: apiEndpointUrl(settings.apiBaseUrl, "trpc"),
        fetch: async (url, init) => {
          const headers = new Headers(init?.headers);
          const apiKey = settings.apiKey.trim();
          if (apiKey.length > 0) {
            headers.set("x-api-key", apiKey);
          }
          const userOpenAiApiKey = settings.openaiApiKey.trim();
          if (options.includeUserOpenAiHeader && userOpenAiApiKey.length > 0) {
            headers.set("x-openai-api-key", userOpenAiApiKey);
          }

          if (typeof init?.body === "string" && init.body.length > 0) {
            const bodyBytes = utf8ByteLength(init.body);
            if (bodyBytes > TRPC_REQUEST_BODY_LIMIT_BYTES) {
              throw new ApiClientError(
                `tRPC request body too large (${bodyBytes.toString()} bytes > ${TRPC_REQUEST_BODY_LIMIT_BYTES.toString()} bytes)`,
                { errorCode: "PAYLOAD_TOO_LARGE" },
              );
            }
            const signature = await computeHmac(
              attestationSecretFor(settings),
              init.body,
            );
            headers.set("x-openerrata-signature", signature);
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

          return fetch(url, requestInit);
        },
      }),
    ],
  });

  cachedClientsByKey.set(key, client);
  return client;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPayloadTooLargeError(error: unknown): boolean {
  const message = describeError(error);
  return (
    message.includes("Content-length of") &&
    message.includes("exceeds limit of") &&
    message.includes("bytes")
  );
}

async function withTrpcClient<Output>(
  path: ExtensionApiProcedurePath,
  operation: (client: TrpcClient) => Promise<Output>,
): Promise<Output> {
  await init();
  await assertApiHostPermissionGranted(settings.apiBaseUrl);

  const client = getOrCreateTrpcClient({
    includeUserOpenAiHeader: shouldIncludeUserOpenAiKeyHeader(path),
  });
  try {
    return await operation(client);
  } catch (error) {
    const errorCode =
      (error instanceof ApiClientError ? error.errorCode : undefined) ??
      extractApiErrorCode(error) ??
      (isPayloadTooLargeError(error) ? "PAYLOAD_TOO_LARGE" : undefined);
    throw new ApiClientError(
      `${describeError(error)} (apiBaseUrl=${settings.apiBaseUrl}, path=${path})`,
      {
        cause: error,
        ...(errorCode === undefined ? {} : { errorCode }),
      },
    );
  }
}

async function queryApi<Path extends ExtensionApiQueryPath>(
  path: Path,
  input: ExtensionApiInput<Path>,
): Promise<ExtensionApiOutput<Path>> {
  return withTrpcClient(path, (client) =>
    client.query(path, input),
  ) as Promise<ExtensionApiOutput<Path>>;
}

async function mutateApi<Path extends ExtensionApiMutationPath>(
  path: Path,
  input: ExtensionApiInput<Path>,
): Promise<ExtensionApiOutput<Path>> {
  return withTrpcClient(path, (client) =>
    client.mutation(path, input),
  ) as Promise<ExtensionApiOutput<Path>>;
}

function normalizeRecordViewAndGetStatusOutput(
  value: ParsedViewPostOutput,
): ViewPostOutput {
  return value;
}

function normalizeGetInvestigationOutput(
  value: ParsedGetInvestigationOutput,
): GetInvestigationOutput {
  return value;
}

function normalizeInvestigateNowOutput(
  value: ParsedInvestigateNowOutput,
): InvestigateNowOutput {
  return value;
}

async function assertApiHostPermissionGranted(apiBaseUrl: string): Promise<void> {
  const originPermission = apiHostPermissionFor(apiBaseUrl);
  const hasPermission = await browser.permissions.contains({
    origins: [originPermission],
  });
  if (hasPermission) return;

  const origin = new URL(apiBaseUrl).origin;
  throw new Error(
    `Missing host permission for ${origin}. Open extension settings and save to grant access.`,
  );
}

export async function recordViewAndGetStatus(
  input: ViewPostInput,
): Promise<ViewPostOutput> {
  const output = viewPostOutputSchema.parse(
    await mutateApi(EXTENSION_TRPC_PATH.RECORD_VIEW_AND_GET_STATUS, input),
  );
  return normalizeRecordViewAndGetStatusOutput(output);
}

export async function getInvestigation(
  input: GetInvestigationInput,
): Promise<GetInvestigationOutput> {
  const output = getInvestigationOutputSchema.parse(
    await queryApi(EXTENSION_TRPC_PATH.GET_INVESTIGATION, input),
  );
  return normalizeGetInvestigationOutput(output);
}

export async function investigateNow(
  input: ViewPostInput,
): Promise<InvestigateNowOutput> {
  const output = investigateNowOutputSchema.parse(
    await mutateApi(EXTENSION_TRPC_PATH.INVESTIGATE_NOW, input),
  );
  return normalizeInvestigateNowOutput(output);
}

export function hasUserOpenAiKey(): boolean {
  return settings.openaiApiKey.trim().length > 0;
}

export function isAutoInvestigateEnabled(): boolean {
  return settings.autoInvestigate;
}
