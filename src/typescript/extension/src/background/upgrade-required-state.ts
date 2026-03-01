/**
 * Single source of truth for the in-memory upgrade-required state.
 *
 * The persistent copy lives in browser.storage.local under the
 * UPGRADE_REQUIRED_STORAGE_KEY. This module owns the in-memory state;
 * callers in index.ts synchronize it with storage and the toolbar
 * badge reads it on demand via getUpgradeRequiredState().
 */

type UpgradeRequiredState =
  | { active: false }
  | { active: true; message: string; apiBaseUrl: string };

let state: UpgradeRequiredState = { active: false };

export function getUpgradeRequiredState(): UpgradeRequiredState {
  return state;
}

export function setUpgradeRequiredState(next: UpgradeRequiredState): void {
  state = next;
}

export function shouldIgnoreMetadataLessUpgradeRequiredRefresh(input: {
  state: UpgradeRequiredState;
  apiBaseUrl: string;
  minimumSupportedExtensionVersion: string | undefined;
}): boolean {
  return (
    input.state.active &&
    input.state.apiBaseUrl === input.apiBaseUrl &&
    input.minimumSupportedExtensionVersion === undefined
  );
}
