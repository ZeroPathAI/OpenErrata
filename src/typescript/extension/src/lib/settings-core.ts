import ipaddr from "ipaddr.js";

export interface ExtensionSettings {
  apiBaseUrl: string;
  apiKey: string;
  openaiApiKey: string;
  autoInvestigate: boolean;
}

const LOCAL_DEV_HOSTNAMES = new Set(["localhost", "host.docker.internal"]);

export const API_BASE_URL_REQUIREMENTS_MESSAGE =
  "API Server URL must use HTTPS. HTTP is allowed only for localhost and private-network development addresses.";

/** The hosted API, used when the user never configured an API Server URL. */
export const DEFAULT_API_BASE_URL = "https://api.openerrata.com";

export const SETTINGS_KEYS = ["apiBaseUrl", "apiKey", "openaiApiKey", "autoInvestigate"] as const;

export type StoredSettings = Partial<Record<(typeof SETTINGS_KEYS)[number], unknown>>;

/**
 * Settings as read from storage. Unset values take their documented defaults;
 * a value that is set but unusable (e.g. an API URL that fails validation) is
 * an error the user must fix — never silently replaced by a default, which
 * would e.g. send a self-hoster's page content to the hosted API.
 */
export type SettingsLoadResult =
  | { kind: "VALID"; settings: ExtensionSettings }
  | { kind: "INVALID"; problem: string };

function normalizeIpLiteralHost(hostname: string): string {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const zoneIndex = unwrapped.indexOf("%");
  if (zoneIndex === -1) {
    return unwrapped;
  }
  return unwrapped.slice(0, zoneIndex);
}

function isPrivateOrLoopbackIpv4(hostname: string): boolean {
  if (!ipaddr.IPv4.isValidFourPartDecimal(hostname)) return false;
  const parsed = ipaddr.IPv4.parse(hostname);
  const isExactUnspecified =
    parsed.octets[0] === 0 &&
    parsed.octets[1] === 0 &&
    parsed.octets[2] === 0 &&
    parsed.octets[3] === 0;
  const range = parsed.range();
  return (
    (range === "unspecified" && isExactUnspecified) ||
    range === "private" ||
    range === "loopback" ||
    range === "linkLocal"
  );
}

function isLocalIpv6(hostname: string): boolean {
  if (!ipaddr.IPv6.isValid(hostname)) return false;
  const parsed = ipaddr.IPv6.parse(hostname);
  if (parsed.isIPv4MappedAddress()) return false;
  const range = parsed.range();
  return (
    range === "unspecified" ||
    range === "loopback" ||
    range === "uniqueLocal" ||
    range === "linkLocal"
  );
}

function isLocalDevelopmentHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const normalizedWithoutTrailingDot = normalized.endsWith(".")
    ? normalized.slice(0, -1)
    : normalized;

  if (normalizedWithoutTrailingDot.length === 0) return false;

  if (LOCAL_DEV_HOSTNAMES.has(normalizedWithoutTrailingDot)) return true;
  if (normalizedWithoutTrailingDot.endsWith(".localhost")) return true;
  const ipLiteralHost = normalizeIpLiteralHost(normalizedWithoutTrailingDot);
  if (isPrivateOrLoopbackIpv4(ipLiteralHost)) return true;
  if (isLocalIpv6(ipLiteralHost)) return true;

  return false;
}

export function normalizeApiBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.protocol === "http:" && !isLocalDevelopmentHost(parsed.hostname)) {
      return null;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

type SettingRead<Value> = { ok: true; value: Value } | { ok: false; problem: string };

function readOptionalString(
  stored: StoredSettings,
  key: "apiKey" | "openaiApiKey",
): SettingRead<string> {
  const value = stored[key];
  if (value === undefined) return { ok: true, value: "" };
  if (typeof value !== "string") {
    return { ok: false, problem: `Stored setting "${key}" is not a string.` };
  }
  return { ok: true, value: value.trim() };
}

function readAutoInvestigate(stored: StoredSettings): SettingRead<boolean> {
  const value = stored.autoInvestigate;
  if (value === undefined) return { ok: true, value: false };
  if (typeof value !== "boolean") {
    return { ok: false, problem: 'Stored setting "autoInvestigate" is not a boolean.' };
  }
  return { ok: true, value };
}

function readApiBaseUrl(stored: StoredSettings): SettingRead<string> {
  const value = stored.apiBaseUrl;
  if (value === undefined) return { ok: true, value: DEFAULT_API_BASE_URL };
  const normalized = normalizeApiBaseUrl(value);
  if (normalized === null) {
    return {
      ok: false,
      problem: `Stored API Server URL ${JSON.stringify(value)} is invalid. ${API_BASE_URL_REQUIREMENTS_MESSAGE}`,
    };
  }
  return { ok: true, value: normalized };
}

export function normalizeOpenaiApiKey(value: string): string {
  return value.trim();
}

export function parseStoredSettings(stored: StoredSettings): SettingsLoadResult {
  const apiBaseUrl = readApiBaseUrl(stored);
  const apiKey = readOptionalString(stored, "apiKey");
  const openaiApiKey = readOptionalString(stored, "openaiApiKey");
  const autoInvestigate = readAutoInvestigate(stored);
  if (!apiBaseUrl.ok) return { kind: "INVALID", problem: apiBaseUrl.problem };
  if (!apiKey.ok) return { kind: "INVALID", problem: apiKey.problem };
  if (!openaiApiKey.ok) return { kind: "INVALID", problem: openaiApiKey.problem };
  if (!autoInvestigate.ok) return { kind: "INVALID", problem: autoInvestigate.problem };
  return {
    kind: "VALID",
    settings: {
      apiBaseUrl: apiBaseUrl.value,
      apiKey: apiKey.value,
      openaiApiKey: openaiApiKey.value,
      autoInvestigate: autoInvestigate.value,
    },
  };
}

export function apiHostPermissionFor(apiBaseUrl: string): string {
  const parsed = new URL(apiBaseUrl);
  return `${parsed.protocol}//${parsed.host}/*`;
}

export function apiEndpointUrl(apiBaseUrl: string, endpointPath: string): string {
  const trimmedEndpointPath = endpointPath.replace(/^\/+/, "");
  const baseWithTrailingSlash = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  return new URL(trimmedEndpointPath, baseWithTrailingSlash).toString();
}
