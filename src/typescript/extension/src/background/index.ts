import browser from "webextension-polyfill";
import { describeError } from "../lib/describe-error.js";
import { createBackgroundRequestListener } from "../lib/messaging.js";
import { ApiClientError } from "./api-client-error.js";
import {
  getInvestigation,
  investigateNow,
  recordViewAndGetStatus,
  registerObservedVersion,
  shouldAutoInvestigate,
  watchSettingsChanges,
} from "./api-client.js";
import {
  addMainFrameCommittedListener,
  addMainFrameDomContentLoadedListener,
  addMainFrameHistoryStateUpdatedListener,
} from "./browser-compat.js";
import {
  ensureContentScript,
  ensureContentScriptsForOpenTabs,
  relayLocationChange,
  sendToTab,
} from "./content-script-injection.js";
import { InvestigationPolling, pollRecoveryAlarmTabId } from "./investigation-polling.js";
import { createBackgroundHandlers, type MessageSender } from "./message-handlers.js";
import { TabStates } from "./tab-state.js";
import { updateToolbarBadge } from "./toolbar-badge.js";
import { getUpgradeRequiredState, setUpgradeRequiredChangeListener } from "./upgrade-required.js";

async function listTabIds(): Promise<number[]> {
  const tabs = await browser.tabs.query({});
  return tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
}

const tabStates = new TabStates({
  storage: {
    get: (key) => browser.storage.session.get(key),
    set: (items) => browser.storage.session.set(items),
    remove: (key) => browser.storage.session.remove(key),
  },
  notifyTab: async (tabId, status) => {
    // A tab without a content script (it navigated away) needs no update.
    await sendToTab(tabId, "STATUS_CHANGED", { status });
  },
  updateBadge: updateToolbarBadge,
  listTabIds,
});

const polling = new InvestigationPolling({
  tabStates,
  getInvestigation,
  alarms: {
    create: (name, info) => browser.alarms.create(name, info),
    clear: (name) => browser.alarms.clear(name),
  },
});

function logFailure(context: string): (error: unknown) => void {
  return (error) => {
    console.error(`${context}:`, error);
  };
}

// ── Messages ──────────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener(
  createBackgroundRequestListener<MessageSender>(
    createBackgroundHandlers({
      tabStates,
      polling,
      api: {
        registerObservedVersion,
        recordViewAndGetStatus,
        investigateNow,
        shouldAutoInvestigate,
      },
      getUpgradeRequiredState,
    }),
    (error) => {
      // An outdated extension is an expected state, surfaced by the popup.
      if (!(error instanceof ApiClientError && error.errorCode === "UPGRADE_REQUIRED")) {
        console.error("Background handler error:", error);
      }
      return Promise.resolve({
        ok: false,
        error: describeError(error),
        ...(error instanceof ApiClientError && error.errorCode !== undefined
          ? { errorCode: error.errorCode }
          : {}),
      });
    },
  ),
);

// ── Settings and compatibility ────────────────────────────────────────────

watchSettingsChanges();
setUpgradeRequiredChangeListener(() => {
  void tabStates.syncBadges().catch(logFailure("Toolbar badge sync failed"));
});

// ── Tab lifecycle and navigation ──────────────────────────────────────────

browser.tabs.onRemoved.addListener((tabId) => {
  polling.stop(tabId);
  void tabStates.forgetTab(tabId).catch(logFailure("Failed to forget closed tab"));
});

// A new document in the tab ends every page session of the old one.
// Same-document (History API) navigations are not commits; the content script
// handles those as page-session transitions.
addMainFrameCommittedListener(({ tabId }) => {
  polling.stop(tabId);
  void tabStates.forgetTab(tabId).catch(logFailure("Failed to reset tab on navigation"));
});

// Custom-domain Substack pages get the content script as soon as their DOM is
// parseable, rather than when all subresources finish loading (`complete` can
// come 5-8 seconds after the article is visible). Known platform pages use
// declarative content scripts.
addMainFrameDomContentLoadedListener(({ tabId, url }) => {
  void ensureContentScript(tabId, url).catch(logFailure("Content script injection failed"));
});

addMainFrameHistoryStateUpdatedListener(({ tabId, url }) => {
  void relayLocationChange(tabId, url).catch(logFailure("Location change relay failed"));
});

// Tabs open since before the extension was installed or updated have no
// content script until something injects one.
browser.tabs.onActivated.addListener(({ tabId }) => {
  void browser.tabs
    .get(tabId)
    .then(async (tab) => {
      if (tab.url === undefined || tab.url.length === 0) return;
      await ensureContentScript(tabId, tab.url);
    })
    .catch(logFailure("Content script injection on tab activation failed"));
});

// ── Investigation polling recovery ────────────────────────────────────────

browser.alarms.onAlarm.addListener((alarm) => {
  const tabId = pollRecoveryAlarmTabId(alarm.name);
  if (tabId === null) return;
  void polling.resume(tabId).catch(logFailure("Failed to resume polling from alarm"));
});

// ── Install / update ──────────────────────────────────────────────────────

browser.runtime.onInstalled.addListener(() => {
  // Versions up to 0.3.3 kept per-tab statuses in storage.local, where they
  // outlived the browser session (and the tab ids they were keyed by), and had
  // an attestation secret override setting ("hmacSecret").
  void browser.storage.local
    .get(null)
    .then((items) => {
      const legacyKeys = Object.keys(items).filter(
        (key) => key.startsWith("tab:") || key === "hmacSecret",
      );
      return legacyKeys.length === 0 ? undefined : browser.storage.local.remove(legacyKeys);
    })
    .catch(logFailure("Failed to remove legacy storage keys"));
});

// ── Every worker start ────────────────────────────────────────────────────

void ensureContentScriptsForOpenTabs().catch(logFailure("Content script startup injection failed"));
void tabStates.syncBadges().catch(logFailure("Toolbar badge startup sync failed"));
void listTabIds()
  .then((tabIds) => Promise.all(tabIds.map((tabId) => polling.resume(tabId))))
  .catch(logFailure("Investigation polling startup restore failed"));
