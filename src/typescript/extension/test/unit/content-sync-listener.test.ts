import assert from "node:assert/strict";
import { test } from "node:test";

type ContentSyncClientCtor = new () => {
  installCachedStatusListener(listener: () => void): () => void;
};

type StorageListener = (changes: Record<string, unknown>, areaName: string) => void;

let registeredStorageListener: StorageListener | null = null;

const contentSyncChromeMock = {
  runtime: {
    id: "test-extension",
    sendMessage: () => Promise.resolve(null),
  },
  storage: {
    local: {},
    onChanged: {
      addListener: (listener: StorageListener) => {
        registeredStorageListener = listener;
      },
      removeListener: (listener: StorageListener) => {
        if (registeredStorageListener === listener) {
          registeredStorageListener = null;
        }
      },
    },
  },
};

(globalThis as { chrome?: unknown }).chrome = contentSyncChromeMock;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isContentSyncClientCtor(value: unknown): value is ContentSyncClientCtor {
  return typeof value === "function";
}

async function importContentSyncClientCtor(): Promise<ContentSyncClientCtor> {
  const importedModule: unknown = await import(
    `../../src/content/sync.ts?test=${Date.now().toString()}-${Math.random().toString()}`
  );

  if (!isRecord(importedModule)) {
    throw new Error("Expected content sync module export object");
  }

  const ctor = importedModule["ContentSyncClient"];
  if (!isContentSyncClientCtor(ctor)) {
    throw new Error("Expected ContentSyncClient constructor export");
  }

  return ctor;
}

function emitStorageChange(changes: Record<string, unknown>, areaName = "local"): void {
  assert.notEqual(registeredStorageListener, null);
  registeredStorageListener?.(changes, areaName);
}

test("installCachedStatusListener reacts to tab and upgrade-required key updates", async () => {
  const ContentSyncClient = await importContentSyncClientCtor();
  const client = new ContentSyncClient();

  let invocationCount = 0;
  const uninstall = client.installCachedStatusListener(() => {
    invocationCount += 1;
  });

  emitStorageChange({ "tab:12": { newValue: { state: "changed" } } });
  assert.equal(invocationCount, 1);

  emitStorageChange({ "runtime:upgrade-required": { newValue: { message: "Update required" } } });
  assert.equal(invocationCount, 2);

  emitStorageChange({ apiBaseUrl: { newValue: "https://api.example.com" } });
  assert.equal(invocationCount, 2);

  emitStorageChange({ "runtime:upgrade-required": { newValue: { message: "ignored" } } }, "sync");
  assert.equal(invocationCount, 2);

  uninstall();
  assert.equal(registeredStorageListener, null);
});
