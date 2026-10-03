import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extensionPageStatusSchema, type ExtensionPageStatus } from "@openerrata/shared";
import {
  chromium,
  type BrowserContext,
  type Page,
  type Route,
  type Worker,
} from "@playwright/test";

/** Hosted API origin the extension talks to with default settings. */
const API_TRPC_PREFIX = "https://api.openerrata.com/trpc/";
const DEFAULT_TIMEOUT_MS = 15_000;

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((done) => {
    setTimeout(done, ms);
  });
}

/** One tRPC call the extension made to the (mocked) API. */
export interface RecordedApiCall {
  path: string;
  input: unknown;
}

/**
 * Answers the extension's tRPC calls. Return the procedure output; the
 * harness wraps it in tRPC's response envelope.
 */
export type MockApiHandler = (call: RecordedApiCall) => unknown;

const VERSION_HASH = "a".repeat(64);

/** A mock API where every post version is registered and not yet investigated. */
export function notInvestigatedApi(call: RecordedApiCall): unknown {
  return defaultApiOutput(call, {
    investigationState: "NOT_INVESTIGATED",
    priorInvestigationResult: null,
  });
}

export function defaultApiOutput(call: RecordedApiCall, viewOutput: unknown): unknown {
  switch (call.path) {
    case "post.registerObservedVersion": {
      const input = call.input as {
        platform: string;
        externalId?: string;
        metadata: { pageId?: string; language?: string };
      };
      const externalId =
        input.platform === "WIKIPEDIA"
          ? `${String(input.metadata.language)}:${String(input.metadata.pageId)}`
          : String(input.externalId);
      return {
        platform: input.platform,
        externalId,
        versionHash: VERSION_HASH,
        postVersionId: `version-${externalId}`,
        provenance: "CLIENT_FALLBACK",
      };
    }
    case "post.recordViewAndGetStatus":
      return viewOutput;
    default:
      throw new Error(`Unexpected API call in e2e test: ${call.path}`);
  }
}

export interface ExtensionHarness {
  context: BrowserContext;
  serviceWorker: Worker;
  apiCalls: RecordedApiCall[];
  close(): Promise<void>;
}

async function fulfillApiCall(route: Route, handler: MockApiHandler, calls: RecordedApiCall[]) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace(/^\/trpc\//, "");
  const rawInput = request.method() === "GET" ? url.searchParams.get("input") : request.postData();
  const call: RecordedApiCall = {
    path,
    input:
      rawInput === null || rawInput.length === 0 ? undefined : (JSON.parse(rawInput) as unknown),
  };
  calls.push(call);
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ result: { data: handler(call) } }),
  });
}

/**
 * The built extension in headless Chromium (no window ever opens), with the
 * API mocked by `apiHandler` — tests never reach a real API server.
 */
export async function launchExtensionHarness(
  apiHandler: MockApiHandler = notInvestigatedApi,
): Promise<ExtensionHarness> {
  const extensionPath = resolve(process.cwd(), "dist");
  const userDataDir = mkdtempSync(join(tmpdir(), "openerrata-extension-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // The full Chromium build's new headless mode loads extensions (service
    // worker and content scripts) without opening any window.
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });

  const apiCalls: RecordedApiCall[] = [];
  // Routes on the context also intercept the extension service worker's fetches.
  await context.route(`${API_TRPC_PREFIX}**`, (route) =>
    fulfillApiCall(route, apiHandler, apiCalls),
  );

  const serviceWorker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
  });

  return {
    context,
    serviceWorker,
    apiCalls,
    async close() {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/** Serve `html` for every request to `url` (and its query/hash variants) in this context. */
export async function servePage(page: Page, url: string, html: string): Promise<void> {
  await page.route(`${url}**`, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: html });
  });
}

async function tabIdForUrl(serviceWorker: Worker, url: string): Promise<number | null> {
  return serviceWorker.evaluate(async (pageUrl: string) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(
      (candidate) => candidate.url === pageUrl || candidate.pendingUrl === pageUrl,
    );
    return tab?.id ?? null;
  }, url);
}

/** The status the background cached for the tab showing `url`, as stored in `storage.session`. */
export async function readCachedStatus(
  serviceWorker: Worker,
  url: string,
): Promise<ExtensionPageStatus | null> {
  const tabId = await tabIdForUrl(serviceWorker, url);
  if (tabId === null) return null;
  const stored = await serviceWorker.evaluate(async (id: number) => {
    const key = `tab:${id.toString()}`;
    const record = await chrome.storage.session.get(key);
    return record[key] as unknown;
  }, tabId);
  return stored === undefined ? null : extensionPageStatusSchema.parse(stored);
}

/** Whether the tab showing `url` has a live content script (side-effect-free PING). */
export async function pingContentScript(serviceWorker: Worker, url: string): Promise<boolean> {
  const tabId = await tabIdForUrl(serviceWorker, url);
  if (tabId === null) return false;
  return serviceWorker.evaluate(async (id: number) => {
    try {
      const response = (await chrome.tabs.sendMessage(
        id,
        { type: "PING", payload: null },
        { frameId: 0 },
      )) as { ok?: boolean } | undefined;
      return response?.ok === true;
    } catch {
      return false;
    }
  }, tabId);
}

export async function waitFor<T>(
  description: string,
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const startedAt = Date.now();
  let last: T = await read();
  while (!matches(last)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `Timed out after ${timeoutMs.toString()}ms waiting for ${description}; last value: ${JSON.stringify(last)}`,
      );
    }
    await sleep(200);
    last = await read();
  }
  return last;
}

export async function waitForCachedStatus(
  harness: ExtensionHarness,
  url: string,
  matches: (status: ExtensionPageStatus) => boolean,
  description: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ExtensionPageStatus> {
  const status = await waitFor(
    description,
    () => readCachedStatus(harness.serviceWorker, url),
    (value) => value !== null && matches(value),
    timeoutMs,
  );
  if (status === null) throw new Error(`No status for ${url}`);
  return status;
}
