import { isNonNullObject } from "@openerrata/shared";
import browser from "webextension-polyfill";

interface NavigationDetails {
  frameId: number;
  tabId: number;
  url: string;
}

interface ScriptingApi {
  executeScript: (details: {
    target: { tabId: number };
    func?: () => unknown;
    files?: string[];
  }) => Promise<{ result?: unknown }[]>;
  insertCSS: (details: { target: { tabId: number }; files: string[] }) => Promise<void>;
}

interface WebNavigationEvent {
  addListener: (listener: (details: NavigationDetails) => void) => void;
}

interface WebNavigationApi {
  onDOMContentLoaded: WebNavigationEvent;
  onHistoryStateUpdated: WebNavigationEvent;
}

function isScriptingApi(value: unknown): value is ScriptingApi {
  if (!isNonNullObject(value)) {
    return false;
  }

  return typeof value["executeScript"] === "function" && typeof value["insertCSS"] === "function";
}

function isWebNavigationEvent(value: unknown): value is WebNavigationEvent {
  return isNonNullObject(value) && typeof value["addListener"] === "function";
}

function isWebNavigationApi(value: unknown): value is WebNavigationApi {
  if (!isNonNullObject(value)) {
    return false;
  }

  return (
    isWebNavigationEvent(value["onDOMContentLoaded"]) &&
    isWebNavigationEvent(value["onHistoryStateUpdated"])
  );
}

function getScriptingApi(): ScriptingApi {
  const scripting: unknown = Reflect.get(browser as object, "scripting");
  if (!isScriptingApi(scripting)) {
    throw new Error(
      "browser.scripting is unavailable in this runtime; OpenErrata requires the WebExtensions scripting API.",
    );
  }
  return scripting;
}

function getWebNavigationApi(): WebNavigationApi | null {
  const webNavigation: unknown = Reflect.get(browser as object, "webNavigation");
  if (!isWebNavigationApi(webNavigation)) {
    return null;
  }
  return webNavigation;
}

export async function executeTabFunction<TResult>(
  tabId: number,
  func: () => TResult,
): Promise<TResult | undefined> {
  const [probeResult] = await getScriptingApi().executeScript({
    target: { tabId },
    func,
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- executeScript returns unknown; callers own the type contract
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
