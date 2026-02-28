import {
  extensionPostStatusSchema,
  extensionSkippedStatusSchema,
  isNonNullObject,
} from "@openerrata/shared";
import type {
  ExtensionPageStatus,
  ExtensionPostStatus,
  ExtensionSkippedStatus,
} from "@openerrata/shared";

interface TabCacheRecord {
  activePostStatus: ExtensionPostStatus | null;
  skippedStatus: ExtensionSkippedStatus | null;
}

type StorageRecord = Record<string, unknown>;

export interface CacheBrowserApi {
  storage: {
    local: {
      get: (key: string) => Promise<StorageRecord>;
      set: (items: StorageRecord) => Promise<void>;
      remove: (key: string) => Promise<void>;
    };
  };
  tabs: {
    query: () => Promise<{ id?: number }[]>;
  };
}

interface CacheStoreDeps {
  browserApi: CacheBrowserApi;
  updateBadge: (tabId: number, status: ExtensionPostStatus | null) => void;
  warn: (message?: unknown, ...optionalParams: unknown[]) => void;
}

interface TabStatusCacheStore {
  cachePostStatus: (
    tabId: number | undefined,
    status: ExtensionPostStatus,
    options?: { setActive?: boolean },
  ) => Promise<void>;
  cacheSkippedStatus: (tabId: number | undefined, status: ExtensionSkippedStatus) => Promise<void>;
  clearActiveStatus: (tabId: number | undefined) => Promise<void>;
  getActiveStatus: (tabId: number) => Promise<ExtensionPageStatus | null>;
  getActivePostStatus: (tabId: number) => Promise<ExtensionPostStatus | null>;
  clearCache: (tabId: number) => void;
  syncToolbarBadgesForOpenTabs: () => Promise<void>;
}

function storageKey(tabId: number): string {
  return `tab:${tabId.toString()}`;
}

function emptyRecord(): TabCacheRecord {
  return {
    activePostStatus: null,
    skippedStatus: null,
  };
}

function parseStoredRecord(stored: unknown): TabCacheRecord | null {
  if (!isNonNullObject(stored)) return null;

  const skippedStatusParsed = extensionSkippedStatusSchema.safeParse(stored["skippedStatus"]);
  const skippedStatus: ExtensionSkippedStatus | null = skippedStatusParsed.success
    ? skippedStatusParsed.data
    : null;

  const activePostStatusParsed = extensionPostStatusSchema.safeParse(stored["activePostStatus"]);
  const activePostStatus: ExtensionPostStatus | null = activePostStatusParsed.success
    ? activePostStatusParsed.data
    : null;

  return {
    activePostStatus,
    skippedStatus,
  };
}

function matchesActiveStatus(
  activeStatus: ExtensionPostStatus,
  incomingStatus: ExtensionPostStatus,
): boolean {
  if (activeStatus.tabSessionId !== incomingStatus.tabSessionId) {
    return false;
  }

  if (
    activeStatus.platform !== incomingStatus.platform ||
    activeStatus.externalId !== incomingStatus.externalId ||
    activeStatus.pageUrl !== incomingStatus.pageUrl
  ) {
    return false;
  }

  if (activeStatus.investigationId !== undefined && incomingStatus.investigationId !== undefined) {
    return activeStatus.investigationId === incomingStatus.investigationId;
  }

  return true;
}

export function createTabStatusCacheStore(deps: CacheStoreDeps): TabStatusCacheStore {
  const memoryCache = new Map<number, TabCacheRecord>();

  async function loadRecord(tabId: number): Promise<TabCacheRecord> {
    const fromMemory = memoryCache.get(tabId);
    if (fromMemory) return fromMemory;

    try {
      const key = storageKey(tabId);
      const stored = await deps.browserApi.storage.local.get(key);
      const parsed = parseStoredRecord(stored[key]);
      if (parsed) {
        memoryCache.set(tabId, parsed);
        return parsed;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load extension cache record for tab ${tabId.toString()}: ${reason}`,
        { cause: error },
      );
    }

    const created = emptyRecord();
    memoryCache.set(tabId, created);
    return created;
  }

  async function saveRecord(tabId: number, record: TabCacheRecord): Promise<void> {
    memoryCache.set(tabId, record);
    try {
      const key = storageKey(tabId);
      await deps.browserApi.storage.local.set({ [key]: record });
    } catch (error) {
      // Best effort cache. Memory copy still works while worker is alive.
      deps.warn("Failed to persist extension cache record:", error);
    }
  }

  async function cachePostStatus(
    tabId: number | undefined,
    status: ExtensionPostStatus,
    options: { setActive?: boolean } = {},
  ): Promise<void> {
    if (tabId === undefined) return;
    const setActive = options.setActive ?? true;
    const record = await loadRecord(tabId);

    if (setActive) {
      record.skippedStatus = null;
      record.activePostStatus = status;
      await saveRecord(tabId, record);
      deps.updateBadge(tabId, status);
      return;
    }

    if (!record.activePostStatus) return;
    if (!matchesActiveStatus(record.activePostStatus, status)) return;

    // setActive=false updates are full replacements gated by identity matching.
    record.activePostStatus = status;
    await saveRecord(tabId, record);
    deps.updateBadge(tabId, status);
  }

  async function cacheSkippedStatus(
    tabId: number | undefined,
    status: ExtensionSkippedStatus,
  ): Promise<void> {
    if (tabId === undefined) return;
    const record = await loadRecord(tabId);
    record.activePostStatus = null;
    record.skippedStatus = status;
    await saveRecord(tabId, record);
    deps.updateBadge(tabId, null);
  }

  async function clearActiveStatus(tabId: number | undefined): Promise<void> {
    if (tabId === undefined) return;
    const record = await loadRecord(tabId);
    record.activePostStatus = null;
    record.skippedStatus = null;
    await saveRecord(tabId, record);
    deps.updateBadge(tabId, null);
  }

  async function getActiveStatus(tabId: number): Promise<ExtensionPageStatus | null> {
    const record = await loadRecord(tabId);
    if (record.skippedStatus) {
      return record.skippedStatus;
    }

    return record.activePostStatus;
  }

  async function getActivePostStatus(tabId: number): Promise<ExtensionPostStatus | null> {
    const record = await loadRecord(tabId);
    return record.activePostStatus;
  }

  function clearCache(tabId: number): void {
    memoryCache.delete(tabId);
    deps.updateBadge(tabId, null);
    deps.browserApi.storage.local.remove(storageKey(tabId)).catch((error: unknown) => {
      deps.warn("Failed to clear extension cache for tab:", error);
    });
  }

  async function syncToolbarBadgesForOpenTabs(): Promise<void> {
    const tabs = await deps.browserApi.tabs.query();
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined) return;
        const status = await getActiveStatus(tab.id);
        if (status?.kind === "POST") {
          deps.updateBadge(tab.id, status);
          return;
        }
        deps.updateBadge(tab.id, null);
      }),
    );
  }

  return {
    cachePostStatus,
    cacheSkippedStatus,
    clearActiveStatus,
    getActiveStatus,
    getActivePostStatus,
    clearCache,
    syncToolbarBadgesForOpenTabs,
  };
}
