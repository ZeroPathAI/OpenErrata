export interface ExtensionSettings {
  apiBaseUrl: string;
  apiKey: string;
  openaiApiKey: string;
  autoInvestigate: boolean;
  hmacSecret: string;
}

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

export function normalizeApiBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
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
