import browser from "webextension-polyfill";

import {
  createTabStatusCacheStore,
  type CacheBrowserApi,
  type TabStatusCacheStore,
} from "./cache-store.js";
import { updateToolbarBadge } from "./toolbar-badge.js";

export { createTabStatusCacheStore };
export type { TabStatusCacheStore };

const browserCacheApi: CacheBrowserApi = {
  storage: {
    local: {
      get: async (key: string) => {
        return browser.storage.local.get(key);
      },
      set: async (items: Record<string, unknown>) => {
        await browser.storage.local.set(items);
      },
      remove: async (key: string) => {
        await browser.storage.local.remove(key);
      },
    },
  },
  tabs: {
    query: async () => {
      const tabs = await browser.tabs.query({});
      return tabs.map((tab) => ({ id: tab.id }));
    },
  },
};

const defaultStore = createTabStatusCacheStore({
  browserApi: browserCacheApi,
  updateBadge: updateToolbarBadge,
  warn: (...args: unknown[]) => {
    console.warn(...args);
  },
});

export const cachePostStatus = defaultStore.cachePostStatus;
export const cacheSkippedStatus = defaultStore.cacheSkippedStatus;
export const clearActiveStatus = defaultStore.clearActiveStatus;
export const getActiveStatus = defaultStore.getActiveStatus;
export const getActivePostStatus = defaultStore.getActivePostStatus;
export const clearCache = defaultStore.clearCache;
export const syncToolbarBadgesForOpenTabs = defaultStore.syncToolbarBadgesForOpenTabs;
