import { isNonNullObject, EXTENSION_MESSAGE_PROTOCOL_VERSION } from "@openerrata/shared";
import browser from "webextension-polyfill";
import { isSubstackPostPath } from "../lib/substack-url.js";
import { executeTabFunction, injectTabAssets } from "./browser-compat.js";

const KNOWN_DECLARATIVE_DOMAINS = [
  "substack.com",
  "lesswrong.com",
  "x.com",
  "twitter.com",
  "wikipedia.org",
];

const injectedCustomSubstackTabs = new Map<number, string>();

function isKnownDeclarativeDomain(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return KNOWN_DECLARATIVE_DOMAINS.some(
    (domain) => normalizedHostname === domain || normalizedHostname.endsWith(`.${domain}`),
  );
}

function hasCandidateSubstackPath(url: URL): boolean {
  return isSubstackPostPath(url.pathname);
}

async function detectSubstackDomFingerprint(tabId: number): Promise<boolean> {
  const probeResult = await executeTabFunction(tabId, () => {
    const hasSubstackFingerprint =
      document.querySelector(
        [
          'link[href*="substackcdn.com"]',
          'script[src*="substackcdn.com"]',
          'img[src*="substackcdn.com"]',
          'meta[property="og:url"][content*=".substack.com"]',
          'meta[name="twitter:image"][content*="post_preview/"]',
        ].join(","),
      ) !== null;
    return {
      pathname: window.location.pathname,
      hasSubstackFingerprint,
    };
  });

  if (!isNonNullObject(probeResult)) {
    return false;
  }
  const { pathname, hasSubstackFingerprint } = probeResult;
  if (typeof pathname !== "string" || typeof hasSubstackFingerprint !== "boolean") {
    return false;
  }
  return isSubstackPostPath(pathname) && hasSubstackFingerprint;
}

async function injectContentScriptIntoTab(tabId: number): Promise<void> {
  await injectTabAssets({
    tabId,
    scriptFile: "content/main.js",
    cssFile: "content/annotations.css",
  });
}

async function hasContentScriptListener(tabId: number): Promise<boolean> {
  try {
    await browser.tabs.sendMessage(tabId, {
      v: EXTENSION_MESSAGE_PROTOCOL_VERSION,
      type: "GET_ANNOTATION_VISIBILITY",
    });
    return true;
  } catch {
    return false;
  }
}

export async function maybeInjectKnownDomainContentScript(
  tabId: number,
  tabUrl: string,
): Promise<void> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(tabUrl);
  } catch {
    return;
  }

  if (!isKnownDeclarativeDomain(parsedUrl.hostname)) {
    return;
  }

  if (await hasContentScriptListener(tabId)) {
    return;
  }

  try {
    await injectContentScriptIntoTab(tabId);
  } catch (error) {
    console.error("known-domain content script injection failed:", error);
  }
}

export async function maybeInjectCustomDomainSubstack(
  tabId: number,
  tabUrl: string,
): Promise<void> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(tabUrl);
  } catch {
    return;
  }

  if (isKnownDeclarativeDomain(parsedUrl.hostname)) {
    return;
  }
  if (!hasCandidateSubstackPath(parsedUrl)) {
    return;
  }
  if (injectedCustomSubstackTabs.get(tabId) === tabUrl) {
    return;
  }

  try {
    const isSubstackPage = await detectSubstackDomFingerprint(tabId);
    if (!isSubstackPage) {
      return;
    }

    await injectContentScriptIntoTab(tabId);
    injectedCustomSubstackTabs.set(tabId, tabUrl);
  } catch (error) {
    console.error("custom-domain substack injection failed:", error);
  }
}

export async function ensureSubstackInjectionForOpenTabs(): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || tab.url === undefined || tab.url.length === 0) return;
      await maybeInjectKnownDomainContentScript(tab.id, tab.url);
      await maybeInjectCustomDomainSubstack(tab.id, tab.url);
    }),
  );
}

export function clearInjectedCustomSubstackTab(tabId: number): void {
  injectedCustomSubstackTabs.delete(tabId);
}
