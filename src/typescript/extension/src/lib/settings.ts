import browser from "webextension-polyfill";
import {
  API_BASE_URL_REQUIREMENTS_MESSAGE,
  DEFAULT_API_BASE_URL,
  SETTINGS_KEYS,
  apiEndpointUrl,
  apiHostPermissionFor,
  normalizeApiBaseUrl,
  normalizeOpenaiApiKey,
  parseStoredSettings,
  type ExtensionSettings,
  type SettingsLoadResult,
  type StoredSettings,
} from "./settings-core.js";

export {
  API_BASE_URL_REQUIREMENTS_MESSAGE,
  DEFAULT_API_BASE_URL,
  SETTINGS_KEYS,
  apiEndpointUrl,
  apiHostPermissionFor,
  normalizeApiBaseUrl,
  normalizeOpenaiApiKey,
  type ExtensionSettings,
  type SettingsLoadResult,
};

/** Values for the options form: what is stored, as editable text, even when it is invalid. */
interface SettingsFormValues {
  apiBaseUrl: string;
  apiKey: string;
  openaiApiKey: string;
  autoInvestigate: boolean;
}

async function readStoredSettings(): Promise<StoredSettings> {
  const stored = await browser.storage.local.get([...SETTINGS_KEYS]);
  return {
    apiBaseUrl: stored["apiBaseUrl"],
    apiKey: stored["apiKey"],
    openaiApiKey: stored["openaiApiKey"],
    autoInvestigate: stored["autoInvestigate"],
  };
}

export async function loadExtensionSettings(): Promise<SettingsLoadResult> {
  return parseStoredSettings(await readStoredSettings());
}

export async function loadSettingsFormValues(): Promise<SettingsFormValues> {
  const stored = await readStoredSettings();
  const text = (value: unknown, unset: string): string =>
    typeof value === "string" ? value : unset;
  return {
    apiBaseUrl: text(stored.apiBaseUrl, DEFAULT_API_BASE_URL),
    apiKey: text(stored.apiKey, ""),
    openaiApiKey: text(stored.openaiApiKey, ""),
    autoInvestigate: stored.autoInvestigate === true,
  };
}

export async function saveExtensionSettings(settings: ExtensionSettings): Promise<void> {
  const parsed = parseStoredSettings(settings);
  if (parsed.kind === "INVALID") {
    throw new Error(parsed.problem);
  }
  await browser.storage.local.set({ ...parsed.settings });
}

export async function ensureApiHostPermission(apiBaseUrl: string): Promise<boolean> {
  const origins = [apiHostPermissionFor(apiBaseUrl)];
  const alreadyGranted = await browser.permissions.contains({ origins });
  if (alreadyGranted) return true;
  return browser.permissions.request({ origins });
}
