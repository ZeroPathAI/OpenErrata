import {
  extensionPostStatusSchema,
  extensionSkippedStatusSchema,
} from "@openerrata/shared";
import type {
  ExtensionPageStatus,
  ExtensionPostStatus,
  ExtensionSkippedStatus,
} from "@openerrata/shared";
import browser from "webextension-polyfill";

import { updateToolbarBadge } from "./toolbar-badge.js";

interface TabCacheRecord {
  activePostStatus: ExtensionPostStatus | null;
  skippedStatus: ExtensionSkippedStatus | null;
}

const memoryCache = new Map<number, TabCacheRecord>();
type ParsedExtensionPostStatus = ReturnType<typeof extensionPostStatusSchema.parse>;
type ParsedExtensionSkippedStatus = ReturnType<
  typeof extensionSkippedStatusSchema.parse
>;

function storageKey(tabId: number): string {
  return `tab:${tabId.toString()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyRecord(): TabCacheRecord {
  return {
    activePostStatus: null,
    skippedStatus: null,
  };
}

function normalizeParsedPostStatus(
  status: ParsedExtensionPostStatus,
): ExtensionPostStatus {
  if (status.investigationState === "INVESTIGATED") {
    return {
      kind: "POST",
      tabSessionId: status.tabSessionId,
      platform: status.platform,
      externalId: status.externalId,
      pageUrl: status.pageUrl,
      ...(status.investigationId === undefined
        ? {}
        : { investigationId: status.investigationId }),
      ...(status.provenance === undefined ? {} : { provenance: status.provenance }),
      investigationState: "INVESTIGATED",
      ...(status.status === undefined ? {} : { status: status.status }),
      claims: status.claims,
    };
  }
  if (status.investigationState === "INVESTIGATING") {
    return {
      kind: "POST",
      tabSessionId: status.tabSessionId,
      platform: status.platform,
      externalId: status.externalId,
      pageUrl: status.pageUrl,
      ...(status.investigationId === undefined
        ? {}
        : { investigationId: status.investigationId }),
      ...(status.provenance === undefined ? {} : { provenance: status.provenance }),
      investigationState: "INVESTIGATING",
      status: status.status,
      claims: null,
    };
  }
  if (status.investigationState === "FAILED") {
    return {
      kind: "POST",
      tabSessionId: status.tabSessionId,
      platform: status.platform,
      externalId: status.externalId,
      pageUrl: status.pageUrl,
      ...(status.investigationId === undefined
        ? {}
        : { investigationId: status.investigationId }),
      ...(status.provenance === undefined ? {} : { provenance: status.provenance }),
      investigationState: "FAILED",
      status: "FAILED",
      claims: null,
    };
  }
  return {
    kind: "POST",
    tabSessionId: status.tabSessionId,
    platform: status.platform,
    externalId: status.externalId,
    pageUrl: status.pageUrl,
    ...(status.investigationId === undefined
      ? {}
      : { investigationId: status.investigationId }),
    ...(status.provenance === undefined ? {} : { provenance: status.provenance }),
    investigationState: "NOT_INVESTIGATED",
    claims: null,
  };
}

function normalizeParsedSkippedStatus(
  status: ParsedExtensionSkippedStatus,
): ExtensionSkippedStatus {
  return {
    kind: "SKIPPED",
    tabSessionId: status.tabSessionId,
    platform: status.platform,
    externalId: status.externalId,
    pageUrl: status.pageUrl,
    reason: status.reason,
  };
}

function parseStoredRecord(stored: unknown): TabCacheRecord | null {
  if (!isRecord(stored)) return null;

  // Legacy format from first implementation.
  if (stored["skipped"] === true && typeof stored["reason"] === "string") {
    return emptyRecord();
  }

  const skippedStatusParsed = extensionSkippedStatusSchema.safeParse(
    stored["skippedStatus"],
  );
  const skippedStatus = skippedStatusParsed.success
    ? normalizeParsedSkippedStatus(skippedStatusParsed.data)
    : null;

  const activePostStatusParsed = extensionPostStatusSchema.safeParse(
    stored["activePostStatus"],
  );
  const activePostStatus = activePostStatusParsed.success
    ? normalizeParsedPostStatus(activePostStatusParsed.data)
    : null;

  // Legacy v2 format with activeCanonicalHash + postStatuses map.
  if (!activePostStatus && isRecord(stored["postStatuses"])) {
    const activeCanonicalHash = stored["activeCanonicalHash"];
    if (typeof activeCanonicalHash === "string") {
      const maybeLegacyStatus = stored["postStatuses"][activeCanonicalHash];
      const parsedLegacyStatus = extensionPostStatusSchema.safeParse(maybeLegacyStatus);
      if (parsedLegacyStatus.success) {
        return {
          activePostStatus: normalizeParsedPostStatus(parsedLegacyStatus.data),
          skippedStatus,
        };
      }
    }
  }

  return {
    activePostStatus,
    skippedStatus,
  };
}

async function loadRecord(tabId: number): Promise<TabCacheRecord> {
  const fromMemory = memoryCache.get(tabId);
  if (fromMemory) return fromMemory;

  try {
    const key = storageKey(tabId);
    const stored = await browser.storage.local.get(key);
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
    await browser.storage.local.set({ [key]: record });
  } catch (error) {
    // Best effort cache. Memory copy still works while worker is alive.
    console.warn("Failed to persist extension cache record:", error);
  }
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

  if (
    activeStatus.investigationId !== undefined &&
    incomingStatus.investigationId !== undefined
  ) {
    return activeStatus.investigationId === incomingStatus.investigationId;
  }

  return true;
}

export async function cachePostStatus(
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
    updateToolbarBadge(tabId, status);
    return;
  }

  if (!record.activePostStatus) return;
  if (!matchesActiveStatus(record.activePostStatus, status)) return;

  // setActive=false updates are full replacements gated by identity matching.
  record.activePostStatus = status;
  await saveRecord(tabId, record);
  updateToolbarBadge(tabId, status);
}

export async function cacheSkippedStatus(
  tabId: number | undefined,
  status: ExtensionSkippedStatus,
): Promise<void> {
  if (tabId === undefined) return;
  const record = await loadRecord(tabId);
  record.activePostStatus = null;
  record.skippedStatus = status;
  await saveRecord(tabId, record);
  updateToolbarBadge(tabId, null);
}

export async function clearActiveStatus(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  const record = await loadRecord(tabId);
  record.activePostStatus = null;
  record.skippedStatus = null;
  await saveRecord(tabId, record);
  updateToolbarBadge(tabId, null);
}

export async function getActiveStatus(tabId: number): Promise<ExtensionPageStatus | null> {
  const record = await loadRecord(tabId);
  if (record.skippedStatus) {
    return record.skippedStatus;
  }

  return record.activePostStatus;
}

export async function getActivePostStatus(
  tabId: number,
): Promise<ExtensionPostStatus | null> {
  const record = await loadRecord(tabId);
  return record.activePostStatus;
}

export function clearCache(tabId: number): void {
  memoryCache.delete(tabId);
  updateToolbarBadge(tabId, null);
  browser.storage.local.remove(storageKey(tabId)).catch((error) => {
    console.warn("Failed to clear extension cache for tab:", error);
  });
}

export async function syncToolbarBadgesForOpenTabs(): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      const status = await getActiveStatus(tab.id);
      if (status?.kind === "POST") {
        updateToolbarBadge(tab.id, status);
        return;
      }
      updateToolbarBadge(tab.id, null);
    }),
  );
}
