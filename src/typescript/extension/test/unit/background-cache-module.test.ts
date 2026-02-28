import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionPostStatus, ExtensionSkippedStatus } from "@openerrata/shared";

type CacheModule = typeof import("../../src/background/cache");

interface CacheChromeState {
  storageData: Record<string, unknown>;
  tabsResult: { id?: number }[];
  getCalls: unknown[];
  setCalls: unknown[];
  removeCalls: unknown[];
  queryCalls: unknown[];
}

const cacheChromeState: CacheChromeState = {
  storageData: {},
  tabsResult: [],
  getCalls: [],
  setCalls: [],
  removeCalls: [],
  queryCalls: [],
};

function maybeCallback<T>(callback: unknown, value: T): Promise<T> {
  if (typeof callback === "function") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- callback type narrowed for mock dispatch
    (callback as (input: T) => void)(value);
  }
  return Promise.resolve(value);
}

const cacheChromeMock = {
  runtime: {
    id: "test-extension",
    getURL: (asset: string) => `chrome-extension://test-extension/${asset}`,
  },
  storage: {
    local: {
      get: (key: string, callback?: (value: Record<string, unknown>) => void) => {
        cacheChromeState.getCalls.push(key);
        return maybeCallback(callback, {
          [key]: cacheChromeState.storageData[key],
        });
      },
      set: (items: Record<string, unknown>, callback?: () => void) => {
        cacheChromeState.setCalls.push(items);
        Object.assign(cacheChromeState.storageData, items);
        return maybeCallback(callback, undefined);
      },
      remove: (key: string, callback?: () => void) => {
        cacheChromeState.removeCalls.push(key);
        cacheChromeState.storageData = Object.fromEntries(
          Object.entries(cacheChromeState.storageData).filter(([entryKey]) => entryKey !== key),
        );
        return maybeCallback(callback, undefined);
      },
    },
    onChanged: {
      addListener: () => {},
      removeListener: () => {},
    },
  },
  tabs: {
    query: (queryInfo: unknown, callback?: (tabs: { id?: number }[]) => void) => {
      cacheChromeState.queryCalls.push(queryInfo);
      return maybeCallback(callback, cacheChromeState.tabsResult);
    },
  },
  action: {
    setIcon: (_details: unknown, callback?: () => void) => maybeCallback(callback, undefined),
    setBadgeText: (_details: unknown, callback?: () => void) => maybeCallback(callback, undefined),
    setBadgeBackgroundColor: (_details: unknown, callback?: () => void) =>
      maybeCallback(callback, undefined),
    setTitle: (_details: unknown, callback?: () => void) => maybeCallback(callback, undefined),
  },
};

(globalThis as { chrome?: unknown }).chrome = cacheChromeMock;

function resetCacheChromeState(input: { tabsResult?: { id?: number }[] } = {}): void {
  cacheChromeState.storageData = {};
  cacheChromeState.tabsResult = input.tabsResult ?? [];
  cacheChromeState.getCalls.length = 0;
  cacheChromeState.setCalls.length = 0;
  cacheChromeState.removeCalls.length = 0;
  cacheChromeState.queryCalls.length = 0;
}

function createPostStatus(tabSessionId: number): ExtensionPostStatus {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded type from plain value in test factory
  const sessionId = tabSessionId as ExtensionPostStatus["tabSessionId"];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded type from plain value in test factory
  const externalId = "post-123" as ExtensionPostStatus["externalId"];
  const status: ExtensionPostStatus = {
    kind: "POST",
    tabSessionId: sessionId,
    platform: "X",
    externalId,
    pageUrl: "https://x.com/example/status/123",
    investigationState: "NOT_INVESTIGATED",
    claims: null,
    priorInvestigationResult: null,
  };
  return status;
}

function createSkippedStatus(tabSessionId: number): ExtensionSkippedStatus {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded type from plain value in test factory
  const sessionId = tabSessionId as ExtensionSkippedStatus["tabSessionId"];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded type from plain value in test factory
  const externalId = "post-123" as ExtensionSkippedStatus["externalId"];
  const skippedStatus: ExtensionSkippedStatus = {
    kind: "SKIPPED",
    tabSessionId: sessionId,
    platform: "X",
    externalId,
    pageUrl: "https://x.com/example/status/123",
    reason: "no_text",
  };
  return skippedStatus;
}

async function importCacheModule(): Promise<CacheModule> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dynamic import returns module as any
  return (await import(
    `../../src/background/cache.ts?test=${Date.now().toString()}-${Math.random().toString()}`
  )) as CacheModule;
}

async function waitForAsyncCleanup(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("cache module wires storage/tabs browser APIs and supports cache lifecycle", async () => {
  resetCacheChromeState({
    tabsResult: [{ id: 11 }, { id: 12 }, {}],
  });
  const cacheModule = await importCacheModule();
  const postStatus = createPostStatus(1);
  const skippedStatus = createSkippedStatus(1);

  await cacheModule.cachePostStatus(11, postStatus);
  assert.equal(cacheChromeState.getCalls.includes("tab:11"), true);
  assert.equal(cacheChromeState.setCalls.length > 0, true);
  assert.deepEqual(await cacheModule.getActivePostStatus(11), postStatus);

  await cacheModule.cacheSkippedStatus(11, skippedStatus);
  assert.deepEqual(await cacheModule.getActiveStatus(11), skippedStatus);

  await cacheModule.clearActiveStatus(11);
  assert.equal(await cacheModule.getActiveStatus(11), null);

  cacheModule.clearCache(11);
  await waitForAsyncCleanup();
  assert.equal(cacheChromeState.removeCalls.includes("tab:11"), true);

  await cacheModule.cachePostStatus(12, createPostStatus(2));
  await cacheModule.syncToolbarBadgesForOpenTabs();
  assert.equal(cacheChromeState.queryCalls.length > 0, true);
});
