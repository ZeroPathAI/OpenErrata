import {
  EXTENSION_TRPC_PATH,
  getInvestigationOutputSchema,
  investigateNowOutputSchema,
  registerObservedVersionOutputSchema,
  viewPostOutputSchema,
  type ExtensionApiInput,
  type ExtensionApiMutationPath,
  type ExtensionApiProcedurePath,
  type ExtensionApiQueryPath,
  type GetInvestigationInput,
  type GetInvestigationOutput,
  type InvestigateNowInput,
  type InvestigateNowOutput,
  type RecordViewAndGetStatusInput,
  type RegisterObservedVersionInput,
  type RegisterObservedVersionOutput,
  type ViewPostOutput,
} from "@openerrata/shared";
import { createTRPCUntypedClient, httpLink, type TRPCUntypedClient } from "@trpc/client";
import browser from "webextension-polyfill";
import {
  DEFAULT_EXTENSION_SETTINGS,
  apiEndpointUrl,
  apiHostPermissionFor,
  loadExtensionSettings,
  type ExtensionSettings,
} from "../lib/settings.js";
import { extractApiErrorCode, extractMinimumSupportedExtensionVersion } from "./api-error-code.js";
export { ApiClientError } from "./api-client-error.js";
import { ApiClientError } from "./api-client-error.js";
import {
  assertTrpcResponseAccepted,
  buildTrpcRequestInit,
  clientKeyFor,
  shouldIncludeUserOpenAiKeyHeader,
} from "./api-client-core.js";
import { EXTENSION_VERSION } from "../lib/extension-version.js";

let settings: ExtensionSettings = { ...DEFAULT_EXTENSION_SETTINGS };
let initPromise: Promise<void> | null = null;
let storageListenerRegistered = false;
const cachedClientsByKey = new Map<string, TrpcClient>();

type TrpcClient = TRPCUntypedClient<never>;
type ParsedRegisterObservedVersionOutput = ReturnType<
  typeof registerObservedVersionOutputSchema.parse
>;
type ParsedViewPostOutput = ReturnType<typeof viewPostOutputSchema.parse>;
type ParsedGetInvestigationOutput = ReturnType<typeof getInvestigationOutputSchema.parse>;
type ParsedInvestigateNowOutput = ReturnType<typeof investigateNowOutputSchema.parse>;

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

  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));

  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getOrCreateTrpcClient(options: { includeUserOpenAiHeader: boolean }): TrpcClient {
  const key = clientKeyFor(settings, options.includeUserOpenAiHeader);
  const cachedClient = cachedClientsByKey.get(key);
  if (cachedClient) {
    return cachedClient;
  }

  const client = createTRPCUntypedClient({
    links: [
      httpLink({
        url: apiEndpointUrl(settings.apiBaseUrl, "trpc"),
        fetch: async (url, requestInitInput) => {
          const requestInit = await buildTrpcRequestInit({
            init: requestInitInput,
            settings,
            includeUserOpenAiHeader: options.includeUserOpenAiHeader,
            extensionVersion: EXTENSION_VERSION,
            computeHmac,
          });
          const response = await fetch(url, requestInit);
          assertTrpcResponseAccepted(response.status);
          return response;
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
      (error instanceof ApiClientError ? error.errorCode : undefined) ?? extractApiErrorCode(error);
    const minimumSupportedExtensionVersion =
      (error instanceof ApiClientError ? error.minimumSupportedExtensionVersion : undefined) ??
      extractMinimumSupportedExtensionVersion(error);
    throw new ApiClientError(
      `${describeError(error)} (apiBaseUrl=${settings.apiBaseUrl}, path=${path})`,
      {
        cause: error,
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(minimumSupportedExtensionVersion === undefined
          ? {}
          : { minimumSupportedExtensionVersion }),
      },
    );
  }
}

async function queryApi<Path extends ExtensionApiQueryPath>(
  path: Path,
  input: ExtensionApiInput<Path>,
): Promise<unknown> {
  return withTrpcClient(path, (client) => client.query(path, input));
}

async function mutateApi<Path extends ExtensionApiMutationPath>(
  path: Path,
  input: ExtensionApiInput<Path>,
): Promise<unknown> {
  return withTrpcClient(path, (client) => client.mutation(path, input));
}

function normalizeRecordViewAndGetStatusOutput(value: ParsedViewPostOutput): ViewPostOutput {
  return value;
}

function normalizeRegisterObservedVersionOutput(
  value: ParsedRegisterObservedVersionOutput,
): RegisterObservedVersionOutput {
  return value;
}

function normalizeGetInvestigationOutput(
  value: ParsedGetInvestigationOutput,
): GetInvestigationOutput {
  return value;
}

function normalizeInvestigateNowOutput(value: ParsedInvestigateNowOutput): InvestigateNowOutput {
  return value;
}

function parseApiOutput<T>(input: {
  operation: string;
  value: unknown;
  safeParse: (
    value: unknown,
  ) => { success: true; data: T } | { success: false; error: { message: string } };
}): T {
  const parsed = input.safeParse(input.value);
  if (parsed.success) {
    return parsed.data;
  }

  throw new ApiClientError(
    `Malformed ${input.operation} response from API: ${parsed.error.message}`,
    { errorCode: "INVALID_EXTENSION_MESSAGE" },
  );
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
  input: RecordViewAndGetStatusInput,
): Promise<ViewPostOutput> {
  const output = parseApiOutput({
    operation: EXTENSION_TRPC_PATH.RECORD_VIEW_AND_GET_STATUS,
    value: await mutateApi(EXTENSION_TRPC_PATH.RECORD_VIEW_AND_GET_STATUS, input),
    safeParse: (value) => viewPostOutputSchema.safeParse(value),
  });
  return normalizeRecordViewAndGetStatusOutput(output);
}

export async function registerObservedVersion(
  input: RegisterObservedVersionInput,
): Promise<RegisterObservedVersionOutput> {
  const output = parseApiOutput({
    operation: EXTENSION_TRPC_PATH.REGISTER_OBSERVED_VERSION,
    value: await mutateApi(EXTENSION_TRPC_PATH.REGISTER_OBSERVED_VERSION, input),
    safeParse: (value) => registerObservedVersionOutputSchema.safeParse(value),
  });
  return normalizeRegisterObservedVersionOutput(output);
}

export async function getInvestigation(
  input: GetInvestigationInput,
): Promise<GetInvestigationOutput> {
  const output = parseApiOutput({
    operation: EXTENSION_TRPC_PATH.GET_INVESTIGATION,
    value: await queryApi(EXTENSION_TRPC_PATH.GET_INVESTIGATION, input),
    safeParse: (value) => getInvestigationOutputSchema.safeParse(value),
  });
  return normalizeGetInvestigationOutput(output);
}

export async function investigateNow(input: InvestigateNowInput): Promise<InvestigateNowOutput> {
  const output = parseApiOutput({
    operation: EXTENSION_TRPC_PATH.INVESTIGATE_NOW,
    value: await mutateApi(EXTENSION_TRPC_PATH.INVESTIGATE_NOW, input),
    safeParse: (value) => investigateNowOutputSchema.safeParse(value),
  });
  return normalizeInvestigateNowOutput(output);
}

export function hasUserOpenAiKey(): boolean {
  return settings.openaiApiKey.trim().length > 0;
}

export function isAutoInvestigateEnabled(): boolean {
  return settings.autoInvestigate;
}

export function getCurrentApiBaseUrl(): string {
  return settings.apiBaseUrl;
}
