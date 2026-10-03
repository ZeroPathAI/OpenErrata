import assert from "node:assert/strict";
import { test } from "node:test";

type BrowserCompatModule = typeof import("../../src/background/browser-compat");

interface NavigationDetails {
  frameId: number;
  tabId: number;
  url: string;
}

function createNavigationEventMock() {
  const listeners: ((details: NavigationDetails) => void)[] = [];
  return {
    listeners,
    addListener(listener: (details: NavigationDetails) => void) {
      listeners.push(listener);
    },
    removeListener(listener: (details: NavigationDetails) => void) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    hasListener(listener: (details: NavigationDetails) => void) {
      return listeners.includes(listener);
    },
  };
}

const browserCompatState: {
  executeScriptResult: { result?: unknown }[];
  executeScriptCalls: unknown[];
  insertCssCalls: unknown[];
} = {
  executeScriptResult: [{ result: undefined }],
  executeScriptCalls: [],
  insertCssCalls: [],
};

const domContentLoadedEvent = createNavigationEventMock();
const historyStateUpdatedEvent = createNavigationEventMock();
const committedEvent = createNavigationEventMock();

const chromeMock = {
  runtime: {
    id: "test-extension",
    getURL: (asset: string) => `chrome-extension://test-extension/${asset}`,
  },
  scripting: {
    executeScript: (details: unknown, callback?: (value: { result?: unknown }[]) => void) => {
      browserCompatState.executeScriptCalls.push(details);
      if (typeof callback === "function") {
        callback(browserCompatState.executeScriptResult);
        return;
      }
      return Promise.resolve(browserCompatState.executeScriptResult);
    },
    insertCSS: (details: unknown, callback?: () => void) => {
      browserCompatState.insertCssCalls.push(details);
      if (typeof callback === "function") {
        callback();
        return;
      }
      return Promise.resolve();
    },
  },
  webNavigation: {
    onCommitted: committedEvent,
    onDOMContentLoaded: domContentLoadedEvent,
    onHistoryStateUpdated: historyStateUpdatedEvent,
  },
};

(globalThis as { chrome?: unknown }).chrome = chromeMock;

function installChromeMock(input: { executeScriptResult?: { result?: unknown }[] }) {
  browserCompatState.executeScriptResult = input.executeScriptResult ?? [{ result: undefined }];
  browserCompatState.executeScriptCalls.length = 0;
  browserCompatState.insertCssCalls.length = 0;
  domContentLoadedEvent.listeners.length = 0;
  historyStateUpdatedEvent.listeners.length = 0;
  committedEvent.listeners.length = 0;

  return {
    executeScriptCalls: browserCompatState.executeScriptCalls,
    insertCssCalls: browserCompatState.insertCssCalls,
    domContentLoadedListeners: domContentLoadedEvent.listeners,
    historyStateUpdatedListeners: historyStateUpdatedEvent.listeners,
    committedListeners: committedEvent.listeners,
  };
}

async function importBrowserCompat(): Promise<BrowserCompatModule> {
  return (await import(
    `../../src/background/browser-compat.ts?test=${Date.now().toString()}-${Math.random().toString()}`
  )) as BrowserCompatModule;
}

test("executeTabFunction returns script result and passes tab target", async () => {
  const mocks = installChromeMock({
    executeScriptResult: [{ result: "ok-result" }],
  });
  const { executeTabFunction } = await importBrowserCompat();

  const result = await executeTabFunction(42, () => "unused");

  assert.equal(result, "ok-result");
  assert.equal(mocks.executeScriptCalls.length, 1);

  const [firstCall] = mocks.executeScriptCalls as {
    target: { tabId: number };
    func: unknown;
  }[];
  if (firstCall === undefined) {
    throw new Error("Missing executeScript call");
  }
  assert.deepEqual(firstCall.target, { tabId: 42 });
  assert.equal(typeof firstCall.func, "function");
});

test("injectTabAssets runs script and CSS injection for a tab", async () => {
  const mocks = installChromeMock({});
  const { injectTabAssets } = await importBrowserCompat();

  await injectTabAssets({
    tabId: 123,
    scriptFile: "content/main.js",
    cssFile: "content/styles.css",
  });

  assert.deepEqual(mocks.executeScriptCalls, [
    {
      target: { tabId: 123 },
      files: ["content/main.js"],
    },
  ]);
  assert.deepEqual(mocks.insertCssCalls, [
    {
      target: { tabId: 123 },
      files: ["content/styles.css"],
    },
  ]);
});

test("navigation listeners forward top-frame navigations only", async () => {
  const mocks = installChromeMock({});
  const {
    addMainFrameCommittedListener,
    addMainFrameDomContentLoadedListener,
    addMainFrameHistoryStateUpdatedListener,
  } = await importBrowserCompat();
  const calls: { event: string; details: NavigationDetails }[] = [];

  addMainFrameCommittedListener((details) => calls.push({ event: "committed", details }));
  addMainFrameDomContentLoadedListener((details) => calls.push({ event: "dom", details }));
  addMainFrameHistoryStateUpdatedListener((details) => calls.push({ event: "history", details }));

  const topFrame = { frameId: 0, tabId: 8, url: "https://example.com/page" };
  const subFrame = { frameId: 3, tabId: 8, url: "https://ads.example.com/frame" };
  for (const listeners of [
    mocks.committedListeners,
    mocks.domContentLoadedListeners,
    mocks.historyStateUpdatedListeners,
  ]) {
    assert.equal(listeners.length, 1);
    listeners[0]?.(subFrame);
    listeners[0]?.(topFrame);
  }

  assert.deepEqual(calls, [
    { event: "committed", details: topFrame },
    { event: "dom", details: topFrame },
    { event: "history", details: topFrame },
  ]);
});
