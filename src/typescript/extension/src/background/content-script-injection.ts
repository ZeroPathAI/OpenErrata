import {
  isNonNullObject,
  type ContentRequestPayload,
  type ContentRequestType,
  type ContentResponse,
} from "@openerrata/shared";
import browser from "webextension-polyfill";
import { sendContentRequest, type TabDelivery } from "../lib/messaging.js";
import {
  isPossibleCustomDomainSubstackPage,
  knownHostPageLocator,
  pageLocatorFor,
} from "../lib/page-locator.js";
import { executeTabFunction, injectTabAssets } from "./browser-compat.js";

/** Send a content request to a tab's top-frame content script. */
export async function sendToTab<Type extends ContentRequestType>(
  tabId: number,
  type: Type,
  payload: ContentRequestPayload<Type>,
): Promise<TabDelivery<ContentResponse<Type>>> {
  return sendContentRequest(
    (message) => browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
    type,
    payload,
  );
}

/**
 * Where a page may need the content script injected programmatically:
 * post pages on the platforms' own hosts (declarative injection misses tabs
 * open before install/update and SPA navigations into post paths), and
 * `/p/*` pages on other hosts that turn out to be custom-domain Substack.
 */
type InjectionCandidate = "KNOWN_PLATFORM_PAGE" | "POSSIBLE_CUSTOM_DOMAIN_SUBSTACK";

function injectionCandidate(url: string): InjectionCandidate | null {
  if (knownHostPageLocator(url) !== null) return "KNOWN_PLATFORM_PAGE";
  if (isPossibleCustomDomainSubstackPage(url)) return "POSSIBLE_CUSTOM_DOMAIN_SUBSTACK";
  return null;
}

async function hasSubstackDomFingerprint(tabId: number): Promise<boolean> {
  const probe = await executeTabFunction(tabId, () => ({
    url: window.location.href,
    hasSubstackFingerprint:
      document.querySelector(
        [
          'link[href*="substackcdn.com"]',
          'script[src*="substackcdn.com"]',
          'img[src*="substackcdn.com"]',
          'meta[property="og:url"][content*=".substack.com"]',
          'meta[name="twitter:image"][content*="post_preview/"]',
        ].join(","),
      ) !== null,
  }));
  if (!isNonNullObject(probe)) return false;
  const { url, hasSubstackFingerprint } = probe;
  return (
    typeof url === "string" &&
    pageLocatorFor("SUBSTACK", url) !== null &&
    hasSubstackFingerprint === true
  );
}

const injectionsInFlight = new Map<number, Promise<void>>();

async function injectIfAbsent(tabId: number, candidate: InjectionCandidate): Promise<void> {
  const ping = await sendToTab(tabId, "PING", null);
  if (ping.kind === "DELIVERED") return;
  if (
    candidate === "POSSIBLE_CUSTOM_DOMAIN_SUBSTACK" &&
    !(await hasSubstackDomFingerprint(tabId))
  ) {
    return;
  }
  await injectTabAssets({
    tabId,
    scriptFile: "content/main.js",
    cssFile: "content/annotations.css",
  });
}

/**
 * Make sure a tab showing `url` has a live content script when it may need
 * one. A side-effect-free PING decides whether one is already there, and
 * concurrent calls for a tab share one attempt; the content script itself
 * also refuses to boot twice in a page.
 */
export async function ensureContentScript(tabId: number, url: string): Promise<void> {
  const candidate = injectionCandidate(url);
  if (candidate === null) return;

  const inFlight = injectionsInFlight.get(tabId);
  if (inFlight !== undefined) {
    await inFlight;
    return;
  }
  const attempt = injectIfAbsent(tabId, candidate).finally(() => {
    injectionsInFlight.delete(tabId);
  });
  injectionsInFlight.set(tabId, attempt);
  await attempt;
}

/**
 * Relay a History API navigation to the tab's content script, which cannot
 * observe the page's `pushState` calls itself. A tab without one (e.g. an SPA
 * navigation into a post path the declarative patterns did not cover) gets
 * one injected instead; it reads the new location when it boots.
 */
export async function relayLocationChange(tabId: number, url: string): Promise<void> {
  const delivery = await sendToTab(tabId, "LOCATION_CHANGED", null);
  if (delivery.kind === "NO_RECEIVER") {
    await ensureContentScript(tabId, url);
  }
}

export async function ensureContentScriptsForOpenTabs(): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || tab.url === undefined || tab.url.length === 0) return;
      try {
        await ensureContentScript(tab.id, tab.url);
      } catch (error) {
        console.error(`Content script injection failed for tab ${tab.id.toString()}:`, error);
      }
    }),
  );
}
