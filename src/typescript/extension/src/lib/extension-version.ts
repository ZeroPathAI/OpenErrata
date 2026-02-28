import browser from "webextension-polyfill";

/**
 * The version string of the running extension, read from the manifest at
 * module load time. This module exists solely to deduplicate the
 * `browser.runtime.getManifest().version` call that was previously repeated
 * across `api-client.ts`, `background/index.ts`, and `settings-validation.ts`.
 *
 * Because it imports `webextension-polyfill`, this module must NOT be imported
 * from unit tests that run outside a browser extension context. Test files
 * should mock or stub the version string instead.
 */
export const EXTENSION_VERSION: string = browser.runtime.getManifest().version;
