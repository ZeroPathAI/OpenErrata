import browser from "webextension-polyfill";
import {
  API_BASE_URL_REQUIREMENTS_MESSAGE,
  DEFAULT_EXTENSION_SETTINGS,
  SETTINGS_KEYS,
  apiEndpointUrl,
  apiHostPermissionFor,
  normalizeApiBaseUrl,
  normalizeExtensionSettings,
  normalizeOpenaiApiKey,
  type ExtensionSettings,
  type StoredSettings,
} from "./settings-core.js";

export {
  API_BASE_URL_REQUIREMENTS_MESSAGE,
  DEFAULT_EXTENSION_SETTINGS,
  apiEndpointUrl,
  apiHostPermissionFor,
  normalizeApiBaseUrl,
  normalizeOpenaiApiKey,
  type ExtensionSettings,
};

export async function loadExtensionSettings(): Promise<ExtensionSettings> {
  const stored = (await browser.storage.local.get([...SETTINGS_KEYS])) as StoredSettings;
  return normalizeExtensionSettings(stored);
}

export async function saveExtensionSettings(settings: ExtensionSettings): Promise<void> {
  const normalized = normalizeExtensionSettings(settings);
  await browser.storage.local.set({
    apiBaseUrl: normalized.apiBaseUrl,
    apiKey: normalized.apiKey,
    openaiApiKey: normalized.openaiApiKey,
    autoInvestigate: normalized.autoInvestigate,
    hmacSecret: normalized.hmacSecret,
  });
}

export async function ensureApiHostPermission(apiBaseUrl: string): Promise<boolean> {
  const originPermission = apiHostPermissionFor(apiBaseUrl);
  const origins = [originPermission];

  const alreadyGranted = await browser.permissions.contains({ origins });
  if (alreadyGranted) return true;

  return browser.permissions.request({ origins });
}
