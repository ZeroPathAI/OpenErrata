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

function isScriptingApi(value: unknown): value is ScriptingApi {
  if (!isNonNullObject(value)) {
    return false;
  }

  return typeof value["executeScript"] === "function" && typeof value["insertCSS"] === "function";
}

// `browser.scripting` is MV3-only and missing from the polyfill's types, so it
// is looked up and checked at runtime.
function getScriptingApi(): ScriptingApi {
  const scripting: unknown = Reflect.get(browser as object, "scripting");
  if (!isScriptingApi(scripting)) {
    throw new Error(
      "browser.scripting is unavailable in this runtime; OpenErrata requires the WebExtensions scripting API.",
    );
  }
  return scripting;
}

/** Run `func` in the tab's page; its result crosses a serialization boundary, so callers validate it. */
export async function executeTabFunction(tabId: number, func: () => unknown): Promise<unknown> {
  const [probeResult] = await getScriptingApi().executeScript({
    target: { tabId },
    func,
  });
  return probeResult?.result;
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

function mainFrameOnly(
  listener: (details: NavigationDetails) => void,
): (details: NavigationDetails) => void {
  return (details) => {
    if (details.frameId !== 0) return;
    listener({ frameId: details.frameId, tabId: details.tabId, url: details.url });
  };
}

/** A tab's top frame committed a new document (not a same-document navigation). */
export function addMainFrameCommittedListener(
  listener: (details: NavigationDetails) => void,
): void {
  browser.webNavigation.onCommitted.addListener(mainFrameOnly(listener));
}

export function addMainFrameDomContentLoadedListener(
  listener: (details: NavigationDetails) => void,
): void {
  browser.webNavigation.onDOMContentLoaded.addListener(mainFrameOnly(listener));
}

/** A tab's top frame changed URL through the History API (`pushState`, `replaceState`, traversal). */
export function addMainFrameHistoryStateUpdatedListener(
  listener: (details: NavigationDetails) => void,
): void {
  browser.webNavigation.onHistoryStateUpdated.addListener(mainFrameOnly(listener));
}
