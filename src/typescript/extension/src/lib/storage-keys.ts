/** `storage.local` key of the persisted "API requires a newer extension" state. */
export const UPGRADE_REQUIRED_STORAGE_KEY = "runtime:upgrade-required";

/** `storage.session` key of one tab's cached page status. */
export function tabStatusStorageKey(tabId: number): string {
  return `tab:${tabId.toString()}`;
}
