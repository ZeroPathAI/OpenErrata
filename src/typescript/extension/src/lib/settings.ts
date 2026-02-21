import browser from "webextension-polyfill";

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

const SETTINGS_KEYS = [
  "apiBaseUrl",
  "apiKey",
  "openaiApiKey",
  "autoInvestigate",
  "hmacSecret",
] as const;

type StoredSettings = Partial<Record<(typeof SETTINGS_KEYS)[number], unknown>>;

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

function normalizeExtensionSettings(stored: StoredSettings): ExtensionSettings {
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

export async function loadExtensionSettings(): Promise<ExtensionSettings> {
  const stored = (await browser.storage.local.get([
    ...SETTINGS_KEYS,
  ])) as StoredSettings;
  return normalizeExtensionSettings(stored);
}

export async function saveExtensionSettings(
  settings: ExtensionSettings,
): Promise<void> {
  const normalized = normalizeExtensionSettings(settings);
  await browser.storage.local.set({
    apiBaseUrl: normalized.apiBaseUrl,
    apiKey: normalized.apiKey,
    openaiApiKey: normalized.openaiApiKey,
    autoInvestigate: normalized.autoInvestigate,
    hmacSecret: normalized.hmacSecret,
  });
}

export function apiHostPermissionFor(apiBaseUrl: string): string {
  const parsed = new URL(apiBaseUrl);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export async function ensureApiHostPermission(
  apiBaseUrl: string,
): Promise<boolean> {
  const originPermission = apiHostPermissionFor(apiBaseUrl);
  const origins = [originPermission];

  const alreadyGranted = await browser.permissions.contains({ origins });
  if (alreadyGranted) return true;

  return browser.permissions.request({ origins });
}
