import browser from "webextension-polyfill";

type NavigationDetails = {
  frameId: number;
  tabId: number;
  url: string;
};

type ScriptingApi = {
  executeScript: (details: {
    target: { tabId: number };
    func?: () => unknown;
    files?: string[];
  }) => Promise<Array<{ result?: unknown }>>;
  insertCSS: (details: { target: { tabId: number }; files: string[] }) => Promise<void>;
};

function getScriptingApi(): ScriptingApi {
  const runtimeBrowser = browser as unknown as { scripting?: ScriptingApi };
  if (runtimeBrowser.scripting === undefined) {
    throw new Error(
      "browser.scripting is unavailable in this runtime; OpenErrata requires the WebExtensions scripting API.",
    );
  }
  return runtimeBrowser.scripting;
}

function getWebNavigationApi(): typeof browser.webNavigation | null {
  const runtimeBrowser = browser as unknown as {
    webNavigation?: typeof browser.webNavigation;
  };
  if (runtimeBrowser.webNavigation === undefined) {
    return null;
  }
  return runtimeBrowser.webNavigation;
}

export async function executeTabFunction<TResult>(
  tabId: number,
  func: () => TResult,
): Promise<TResult | undefined> {
  const [probeResult] = await getScriptingApi().executeScript({
    target: { tabId },
    func,
  });
  return probeResult?.result as TResult | undefined;
}

export async function injectTabAssets(input: {
  tabId: number;
  scriptFile: string;
  cssFile: string;
}): Promise<void> {
  const scripting = getScriptingApi();
  await Promise.all([
    scripting.executeScript({
      target: { tabId: input.tabId },
      files: [input.scriptFile],
    }),
    scripting.insertCSS({
      target: { tabId: input.tabId },
      files: [input.cssFile],
    }),
  ]);
}

export function addDomContentLoadedListener(listener: (details: NavigationDetails) => void): void {
  const webNavigation = getWebNavigationApi();
  if (webNavigation === null) {
    console.warn("webNavigation API unavailable; skipping DOMContentLoaded listener.");
    return;
  }
  webNavigation.onDOMContentLoaded.addListener((details) => {
    listener({
      frameId: details.frameId,
      tabId: details.tabId,
      url: details.url,
    });
  });
}

export function addHistoryStateUpdatedListener(
  listener: (details: NavigationDetails) => void,
): void {
  const webNavigation = getWebNavigationApi();
  if (webNavigation === null) {
    console.warn("webNavigation API unavailable; skipping HistoryState listener.");
    return;
  }
  webNavigation.onHistoryStateUpdated.addListener((details) => {
    listener({
      frameId: details.frameId,
      tabId: details.tabId,
      url: details.url,
    });
  });
}
