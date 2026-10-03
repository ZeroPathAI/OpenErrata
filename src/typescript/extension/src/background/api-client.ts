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
  SETTINGS_KEYS,
  apiEndpointUrl,
  apiHostPermissionFor,
  loadExtensionSettings,
  type ExtensionSettings,
  type SettingsLoadResult,
} from "../lib/settings.js";
import { extractApiErrorCode, extractMinimumSupportedExtensionVersion } from "./api-error-code.js";
import { ApiClientError } from "./api-client-error.js";
import { describeError } from "../lib/describe-error.js";
import {
  assertTrpcResponseAccepted,
  buildTrpcRequestInit,
  clientKeyFor,
  shouldIncludeUserOpenAiKeyHeader,
} from "./api-client-core.js";
import { EXTENSION_VERSION } from "../lib/extension-version.js";
import { clearUpgradeRequired, markUpgradeRequired } from "./upgrade-required.js";

// Untyped at the tRPC level: request and response shapes are pinned by the
// shared `ExtensionApiProcedureContract` and validated with the shared output
// schemas below.
type TrpcClient = TRPCUntypedClient<never>;

/** The stored settings, read once and re-read after the user changes them. */
let settingsPromise: Promise<SettingsLoadResult> | null = null;
const cachedClientsByKey = new Map<string, TrpcClient>();

function currentSettings(): Promise<SettingsLoadResult> {
  settingsPromise ??= loadExtensionSettings().catch((error: unknown) => {
    settingsPromise = null;
    throw error;
  });
  return settingsPromise;
}

/** Re-read settings after the options page saves them. */
export function watchSettingsChanges(): void {
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!SETTINGS_KEYS.some((key) => Object.hasOwn(changes, key))) return;

    settingsPromise = null;
    cachedClientsByKey.clear();
    if (Object.hasOwn(changes, "apiBaseUrl")) {
      // An upgrade notice is about one API; a different API may accept us.
      void clearUpgradeRequired().catch((error: unknown) => {
        console.error("Failed to clear upgrade-required state after API URL change:", error);
      });
    }
  });
}

/** Settings usable for API calls, or an INVALID_EXTENSION_SETTINGS error. */
async function requireApiSettings(): Promise<ExtensionSettings> {
  const loaded = await currentSettings();
  if (loaded.kind === "INVALID") {
    throw new ApiClientError(`Extension settings are invalid: ${loaded.problem}`, {
      errorCode: "INVALID_EXTENSION_SETTINGS",
    });
  }
  return loaded.settings;
}

/** Whether a NOT_INVESTIGATED view should start an investigation right away. */
export async function shouldAutoInvestigate(): Promise<boolean> {
  const loaded = await currentSettings();
  return (
    loaded.kind === "VALID" &&
    loaded.settings.autoInvestigate &&
    loaded.settings.openaiApiKey.length > 0
  );
}

function getOrCreateTrpcClient(
  settings: ExtensionSettings,
  options: { includeUserOpenAiHeader: boolean },
): TrpcClient {
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
          const requestInit = buildTrpcRequestInit({
            init: requestInitInput,
            settings,
            includeUserOpenAiHeader: options.includeUserOpenAiHeader,
            extensionVersion: EXTENSION_VERSION,
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

function toApiClientError(
  error: unknown,
  context: { apiBaseUrl: string; path: ExtensionApiProcedurePath },
): ApiClientError {
  const errorCode =
    (error instanceof ApiClientError ? error.errorCode : undefined) ?? extractApiErrorCode(error);
  const minimumSupportedExtensionVersion =
    (error instanceof ApiClientError ? error.minimumSupportedExtensionVersion : undefined) ??
    extractMinimumSupportedExtensionVersion(error);
  return new ApiClientError(
    `${describeError(error)} (apiBaseUrl=${context.apiBaseUrl}, path=${context.path})`,
    {
      cause: error,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(minimumSupportedExtensionVersion === undefined
        ? {}
        : { minimumSupportedExtensionVersion }),
    },
  );
}

/**
 * Run one API call with the current settings. Also tracks API compatibility:
 * an UPGRADE_REQUIRED rejection records the upgrade notice, and any accepted
 * call clears it.
 */
async function withTrpcClient<Output>(
  path: ExtensionApiProcedurePath,
  operation: (client: TrpcClient) => Promise<Output>,
): Promise<Output> {
  const settings = await requireApiSettings();
  let output: Output;
  try {
    await assertApiHostPermissionGranted(settings.apiBaseUrl);
    output = await operation(
      getOrCreateTrpcClient(settings, {
        includeUserOpenAiHeader: shouldIncludeUserOpenAiKeyHeader(path),
      }),
    );
  } catch (error) {
    const apiError = toApiClientError(error, { apiBaseUrl: settings.apiBaseUrl, path });
    if (apiError.errorCode === "UPGRADE_REQUIRED") {
      await markUpgradeRequired({
        apiBaseUrl: settings.apiBaseUrl,
        minimumSupportedExtensionVersion: apiError.minimumSupportedExtensionVersion,
      });
    }
    throw apiError;
  }
  await clearUpgradeRequired();
  return output;
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
  throw new ApiClientError(
    `Missing host permission for ${origin}. Open extension settings and save to grant access.`,
    { errorCode: "INVALID_EXTENSION_SETTINGS" },
  );
}

export async function recordViewAndGetStatus(
  input: RecordViewAndGetStatusInput,
): Promise<ViewPostOutput> {
  return parseApiOutput({
    operation: EXTENSION_TRPC_PATH.RECORD_VIEW_AND_GET_STATUS,
    value: await mutateApi(EXTENSION_TRPC_PATH.RECORD_VIEW_AND_GET_STATUS, input),
    safeParse: (value) => viewPostOutputSchema.safeParse(value),
  });
}

export async function registerObservedVersion(
  input: RegisterObservedVersionInput,
): Promise<RegisterObservedVersionOutput> {
  return parseApiOutput({
    operation: EXTENSION_TRPC_PATH.REGISTER_OBSERVED_VERSION,
    value: await mutateApi(EXTENSION_TRPC_PATH.REGISTER_OBSERVED_VERSION, input),
    safeParse: (value) => registerObservedVersionOutputSchema.safeParse(value),
  });
}

export async function getInvestigation(
  input: GetInvestigationInput,
): Promise<GetInvestigationOutput> {
  return parseApiOutput({
    operation: EXTENSION_TRPC_PATH.GET_INVESTIGATION,
    value: await queryApi(EXTENSION_TRPC_PATH.GET_INVESTIGATION, input),
    safeParse: (value) => getInvestigationOutputSchema.safeParse(value),
  });
}

export async function investigateNow(input: InvestigateNowInput): Promise<InvestigateNowOutput> {
  return parseApiOutput({
    operation: EXTENSION_TRPC_PATH.INVESTIGATE_NOW,
    value: await mutateApi(EXTENSION_TRPC_PATH.INVESTIGATE_NOW, input),
    safeParse: (value) => investigateNowOutputSchema.safeParse(value),
  });
}
