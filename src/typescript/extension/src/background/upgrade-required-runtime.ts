import { isNonNullObject, trimToOptionalNonEmpty } from "@openerrata/shared";
import browser from "webextension-polyfill";
import { ApiClientError, getCurrentApiBaseUrl } from "./api-client.js";
import { syncToolbarBadgesForOpenTabs } from "./cache.js";
import { EXTENSION_VERSION } from "../lib/extension-version.js";
import { UPGRADE_REQUIRED_STORAGE_KEY } from "../lib/runtime-error.js";
import {
  getUpgradeRequiredState,
  setUpgradeRequiredState,
  shouldIgnoreMetadataLessUpgradeRequiredRefresh,
} from "./upgrade-required-state.js";

interface StoredUpgradeRequiredState {
  message: string;
  detectedForVersion: string;
  apiBaseUrl: string;
}

export function isUpgradeRequiredError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError && error.errorCode === "UPGRADE_REQUIRED";
}

export function isTerminalCompatibilityError(error: unknown): error is ApiClientError {
  return (
    error instanceof ApiClientError &&
    (error.errorCode === "UPGRADE_REQUIRED" || error.errorCode === "MALFORMED_EXTENSION_VERSION")
  );
}

function parseStoredUpgradeRequiredState(value: unknown): StoredUpgradeRequiredState | null {
  if (!isNonNullObject(value)) {
    return null;
  }

  const message =
    typeof value["message"] === "string" ? trimToOptionalNonEmpty(value["message"]) : undefined;
  const detectedForVersion =
    typeof value["detectedForVersion"] === "string"
      ? trimToOptionalNonEmpty(value["detectedForVersion"])
      : undefined;
  const apiBaseUrl =
    typeof value["apiBaseUrl"] === "string"
      ? trimToOptionalNonEmpty(value["apiBaseUrl"])
      : undefined;
  if (message === undefined || detectedForVersion === undefined || apiBaseUrl === undefined) {
    return null;
  }

  return {
    message,
    detectedForVersion,
    apiBaseUrl,
  };
}

function upgradeRequiredMessageFromApiError(error: ApiClientError): string {
  const minimumVersion = error.minimumSupportedExtensionVersion;
  if (minimumVersion !== undefined) {
    return `Update required: this API server now requires OpenErrata extension version ${minimumVersion} or newer.`;
  }
  return "Update required: this OpenErrata extension version is no longer supported by the API server.";
}

export async function clearUpgradeRequiredState(): Promise<void> {
  if (!getUpgradeRequiredState().active) {
    return;
  }

  setUpgradeRequiredState({ active: false });
  await browser.storage.local.remove(UPGRADE_REQUIRED_STORAGE_KEY);
  await syncToolbarBadgesForOpenTabs();
}

export async function clearUpgradeRequiredStateBestEffort(operation: string): Promise<void> {
  try {
    await clearUpgradeRequiredState();
  } catch (error) {
    console.warn(`Failed to clear upgrade-required state during ${operation}:`, error);
  }
}

export async function markUpgradeRequiredFromError(error: unknown): Promise<void> {
  if (!isUpgradeRequiredError(error)) {
    return;
  }

  const upgradeRequiredState = getUpgradeRequiredState();
  const apiBaseUrl = getCurrentApiBaseUrl();
  if (
    shouldIgnoreMetadataLessUpgradeRequiredRefresh({
      state: upgradeRequiredState,
      apiBaseUrl,
      minimumSupportedExtensionVersion: error.minimumSupportedExtensionVersion,
    })
  ) {
    return;
  }

  const message = upgradeRequiredMessageFromApiError(error);
  if (
    upgradeRequiredState.active &&
    upgradeRequiredState.message === message &&
    upgradeRequiredState.apiBaseUrl === apiBaseUrl
  ) {
    return;
  }

  setUpgradeRequiredState({ active: true, message, apiBaseUrl });
  await browser.storage.local.set({
    [UPGRADE_REQUIRED_STORAGE_KEY]: {
      message,
      detectedForVersion: EXTENSION_VERSION,
      apiBaseUrl,
    } satisfies StoredUpgradeRequiredState,
  });
  await syncToolbarBadgesForOpenTabs();
}

export async function restoreUpgradeRequiredState(): Promise<void> {
  const storedRecord = await browser.storage.local.get(UPGRADE_REQUIRED_STORAGE_KEY);
  const storedState = parseStoredUpgradeRequiredState(storedRecord[UPGRADE_REQUIRED_STORAGE_KEY]);
  const configuredApiBaseUrl = getCurrentApiBaseUrl();
  const storedApiBaseUrl = storedState?.apiBaseUrl;
  if (
    storedState?.detectedForVersion !== EXTENSION_VERSION ||
    storedApiBaseUrl !== configuredApiBaseUrl
  ) {
    setUpgradeRequiredState({ active: false });
    await browser.storage.local.remove(UPGRADE_REQUIRED_STORAGE_KEY);
    await syncToolbarBadgesForOpenTabs();
    return;
  }

  setUpgradeRequiredState({
    active: true,
    message: storedState.message,
    apiBaseUrl: storedState.apiBaseUrl,
  });
  await syncToolbarBadgesForOpenTabs();
}
