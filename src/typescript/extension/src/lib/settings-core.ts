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

function parseIpv4Octet(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^(0|[1-9]\d{0,2})$/.test(raw)) return null;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) return null;
  return parsed;
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;

  const first = parseIpv4Octet(parts[0]);
  const second = parseIpv4Octet(parts[1]);
  const third = parseIpv4Octet(parts[2]);
  const fourth = parseIpv4Octet(parts[3]);

  if (first === null || second === null || third === null || fourth === null) {
    return null;
  }

  return [first, second, third, fourth];
}

function isPrivateOrLoopbackIpv4(hostname: string): boolean {
  const ipv4 = parseIpv4(hostname);
  if (ipv4 === null) return false;

  const [firstOctet, secondOctet, thirdOctet, fourthOctet] = ipv4;

  if (
    firstOctet === 0 &&
    secondOctet === 0 &&
    thirdOctet === 0 &&
    fourthOctet === 0
  ) {
    return true;
  }
  if (firstOctet === 10) return true;
  if (firstOctet === 127) return true;
  if (firstOctet === 169 && secondOctet === 254) return true;
  if (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) return true;
  if (firstOctet === 192 && secondOctet === 168) return true;

  return false;
}

function parseFirstIpv6Hextet(hostname: string): number | null {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return null;

  const unwrapped = hostname.slice(1, -1).toLowerCase();
  if (unwrapped.length === 0) return null;

  const zoneDelimiterIndex = unwrapped.indexOf("%");
  const address =
    zoneDelimiterIndex === -1
      ? unwrapped
      : unwrapped.slice(0, zoneDelimiterIndex);
  if (address.length === 0) return null;

  const condensedParts = address.split("::");
  if (condensedParts.length > 2) return null;
  const headRaw = condensedParts[0];
  if (headRaw === undefined) return null;

  const headParts = headRaw === "" ? [] : headRaw.split(":");
  const tailRaw = condensedParts[1];
  const tailParts =
    tailRaw === undefined || tailRaw === "" ? [] : tailRaw.split(":");

  const hextets = [...headParts, ...tailParts];
  if (hextets.length > 8) return null;

  for (const hextet of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(hextet)) return null;
  }

  if (headParts.length === 0) return 0;

  const firstHextet = headParts[0];
  if (firstHextet === undefined) return null;

  return Number.parseInt(firstHextet, 16);
}

function isLocalIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "[::1]" || normalized === "[::]") return true;

  const mappedLoopbackMatch = normalized.match(/^\[::ffff:(\d+\.\d+\.\d+\.\d+)\]$/);
  if (mappedLoopbackMatch !== null) {
    const mappedIpv4 = mappedLoopbackMatch[1];
    if (mappedIpv4 === undefined) return false;

    return isPrivateOrLoopbackIpv4(mappedIpv4);
  }

  const firstHextet = parseFirstIpv6Hextet(normalized);
  if (firstHextet === null) return false;

  const isUniqueLocal = (firstHextet & 0xfe00) === 0xfc00; // fc00::/7
  if (isUniqueLocal) return true;

  const isLinkLocal = (firstHextet & 0xffc0) === 0xfe80; // fe80::/10
  if (isLinkLocal) return true;

  return false;
}

function isLocalDevelopmentHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const normalizedWithoutTrailingDot = normalized.endsWith(".")
    ? normalized.slice(0, -1)
    : normalized;

  if (normalizedWithoutTrailingDot.length === 0) return false;

  if (LOCAL_DEV_HOSTNAMES.has(normalizedWithoutTrailingDot)) return true;
  if (normalizedWithoutTrailingDot.endsWith(".localhost")) return true;
  if (isPrivateOrLoopbackIpv4(normalizedWithoutTrailingDot)) return true;
  if (isLocalIpv6(normalizedWithoutTrailingDot)) return true;

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
