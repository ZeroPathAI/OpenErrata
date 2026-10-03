import { isNonNullObject, trimToOptionalNonEmpty } from "@openerrata/shared";
import browser from "webextension-polyfill";
import { EXTENSION_VERSION } from "../lib/extension-version.js";
import { loadExtensionSettings } from "../lib/settings.js";
import { UPGRADE_REQUIRED_STORAGE_KEY } from "../lib/storage-keys.js";

/**
 * Whether the configured API rejects this extension version as too old
 * (spec §3.3). Persisted in `storage.local` so the notice survives restarts;
 * it is dropped when the extension updates or the API Server URL changes, so
 * a REQUIRED state always refers to the currently configured API.
 */
export type UpgradeRequiredState =
  | { kind: "NOT_REQUIRED" }
  | { kind: "REQUIRED"; message: string; apiBaseUrl: string };

interface StoredUpgradeRequiredState {
  message: string;
  detectedForVersion: string;
  apiBaseUrl: string;
}

const NOT_REQUIRED: UpgradeRequiredState = { kind: "NOT_REQUIRED" };

let statePromise: Promise<UpgradeRequiredState> | null = null;
let onChange: () => void = () => undefined;

/** Register what to refresh when the state changes (the toolbar badges). */
export function setUpgradeRequiredChangeListener(listener: () => void): void {
  onChange = listener;
}

function parseStoredState(value: unknown): StoredUpgradeRequiredState | null {
  if (!isNonNullObject(value)) return null;
  const read = (key: string): string | undefined => {
    const field = value[key];
    return typeof field === "string" ? trimToOptionalNonEmpty(field) : undefined;
  };
  const message = read("message");
  const detectedForVersion = read("detectedForVersion");
  const apiBaseUrl = read("apiBaseUrl");
  if (message === undefined || detectedForVersion === undefined || apiBaseUrl === undefined) {
    return null;
  }
  return { message, detectedForVersion, apiBaseUrl };
}

async function restoreState(): Promise<UpgradeRequiredState> {
  const record = await browser.storage.local.get(UPGRADE_REQUIRED_STORAGE_KEY);
  const stored = parseStoredState(record[UPGRADE_REQUIRED_STORAGE_KEY]);
  const settings = await loadExtensionSettings();
  const stillApplies =
    stored !== null &&
    stored.detectedForVersion === EXTENSION_VERSION &&
    settings.kind === "VALID" &&
    settings.settings.apiBaseUrl === stored.apiBaseUrl;
  if (stored === null || !stillApplies) {
    if (record[UPGRADE_REQUIRED_STORAGE_KEY] !== undefined) {
      await browser.storage.local.remove(UPGRADE_REQUIRED_STORAGE_KEY);
    }
    return NOT_REQUIRED;
  }
  return { kind: "REQUIRED", message: stored.message, apiBaseUrl: stored.apiBaseUrl };
}

export function getUpgradeRequiredState(): Promise<UpgradeRequiredState> {
  statePromise ??= restoreState().catch((error: unknown) => {
    statePromise = null;
    throw error;
  });
  return statePromise;
}

function upgradeRequiredMessage(minimumSupportedExtensionVersion: string | undefined): string {
  return minimumSupportedExtensionVersion === undefined
    ? "Update required: this OpenErrata extension version is no longer supported by the API server."
    : `Update required: this API server now requires OpenErrata extension version ${minimumSupportedExtensionVersion} or newer.`;
}

/** Record that the API at `apiBaseUrl` rejected this extension version. */
export async function markUpgradeRequired(input: {
  apiBaseUrl: string;
  minimumSupportedExtensionVersion: string | undefined;
}): Promise<void> {
  const current = await getUpgradeRequiredState();
  if (current.kind === "REQUIRED" && current.apiBaseUrl === input.apiBaseUrl) {
    // Keep a notice that names the minimum version over one that does not.
    if (input.minimumSupportedExtensionVersion === undefined) return;
    if (current.message === upgradeRequiredMessage(input.minimumSupportedExtensionVersion)) return;
  }

  const next: UpgradeRequiredState = {
    kind: "REQUIRED",
    message: upgradeRequiredMessage(input.minimumSupportedExtensionVersion),
    apiBaseUrl: input.apiBaseUrl,
  };
  statePromise = Promise.resolve(next);
  await browser.storage.local.set({
    [UPGRADE_REQUIRED_STORAGE_KEY]: {
      message: next.message,
      detectedForVersion: EXTENSION_VERSION,
      apiBaseUrl: next.apiBaseUrl,
    } satisfies StoredUpgradeRequiredState,
  });
  onChange();
}

/** The API accepted this version again, or the configured API changed. */
export async function clearUpgradeRequired(): Promise<void> {
  const current = await getUpgradeRequiredState();
  if (current.kind === "NOT_REQUIRED") return;
  statePromise = Promise.resolve(NOT_REQUIRED);
  await browser.storage.local.remove(UPGRADE_REQUIRED_STORAGE_KEY);
  onChange();
}
