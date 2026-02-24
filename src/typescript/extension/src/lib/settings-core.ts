import ipaddr from "ipaddr.js";

export interface ExtensionSettings {
  apiBaseUrl: string;
  apiKey: string;
  openaiApiKey: string;
  autoInvestigate: boolean;
  hmacSecret: string;
}

const LOCAL_DEV_HOSTNAMES = new Set([
  "localhost",
  "host.docker.internal",
]);

export const API_BASE_URL_REQUIREMENTS_MESSAGE =
  "API Server URL must use HTTPS. HTTP is allowed only for localhost and private-network development addresses.";

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  apiBaseUrl: "https://api.openerrata.com",
  apiKey: "",
  openaiApiKey: "",
  autoInvestigate: false,
  hmacSecret: "",
};

export const SETTINGS_KEYS = [
  "apiBaseUrl",
  "apiKey",
  "openaiApiKey",
  "autoInvestigate",
  "hmacSecret",
] as const;

export type StoredSettings = Partial<Record<(typeof SETTINGS_KEYS)[number], unknown>>;

function normalizeIpLiteralHost(hostname: string): string {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
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

function normalizeApiKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

export function normalizeOpenaiApiKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeAutoInvestigate(value: unknown): boolean {
  return value === true;
}

function normalizeHmacSecret(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

export function normalizeExtensionSettings(stored: StoredSettings): ExtensionSettings {
  return {
    apiBaseUrl:
      normalizeApiBaseUrl(stored.apiBaseUrl) ??
      DEFAULT_EXTENSION_SETTINGS.apiBaseUrl,
    apiKey: normalizeApiKey(stored.apiKey),
    openaiApiKey: normalizeOpenaiApiKey(stored.openaiApiKey),
    autoInvestigate: normalizeAutoInvestigate(stored.autoInvestigate),
    hmacSecret: normalizeHmacSecret(stored.hmacSecret),
  };
}

export function apiHostPermissionFor(apiBaseUrl: string): string {
  const parsed = new URL(apiBaseUrl);
  return `${parsed.protocol}//${parsed.host}/*`;
}

export function apiEndpointUrl(apiBaseUrl: string, endpointPath: string): string {
  const trimmedEndpointPath = endpointPath.replace(/^\/+/, "");
  const baseWithTrailingSlash = apiBaseUrl.endsWith("/")
    ? apiBaseUrl
    : `${apiBaseUrl}/`;
  return new URL(trimmedEndpointPath, baseWithTrailingSlash).toString();
}
