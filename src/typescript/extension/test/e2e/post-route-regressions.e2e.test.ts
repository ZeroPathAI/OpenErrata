import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EXTENSION_MESSAGE_PROTOCOL_VERSION,
  extensionPageStatusSchema,
  type ExtensionPostStatus,
  type ExtensionSkippedReason,
} from "@openerrata/shared";
import { chromium, test, type BrowserContext, type Worker } from "@playwright/test";
import { E2E_WIKIPEDIA_FIXTURE_KEYS, readE2eWikipediaFixture } from "./wikipedia-fixtures.js";

type Platform = "LESSWRONG" | "X" | "SUBSTACK" | "WIKIPEDIA";

interface ExtensionHarness {
  context: BrowserContext;
  serviceWorker: Worker;
  userDataDir: string;
}

interface ExpectedSkippedStatus {
  platform: Platform;
  externalId: string;
  /** A single reason or array of acceptable reasons (when multiple skip conditions apply). */
  reason: ExtensionSkippedReason | ExtensionSkippedReason[];
  pageUrl?: string;
}

interface ExpectedPostStatus {
  platform: Platform;
  externalId: string;
  pageUrl?: string;
  investigationState?: ExtensionPostStatus["investigationState"];
}

const DEFAULT_STATUS_POLL_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((done) => {
    setTimeout(done, ms);
  });
}

interface CachedStatusProbe {
  tabId: number;
  tabUrl: string | null;
  pendingUrl: string | null;
  status: unknown;
  error: string | null;
}

interface ContentScriptProbe {
  tabId: number;
  tabUrl: string | null;
  pendingUrl: string | null;
  listenerReady: boolean;
  listenerError: string | null;
  injected: boolean;
  injectError: string | null;
}

function summarizeContentScriptProbesForError(probes: ContentScriptProbe[]): string {
  if (probes.length === 0) {
    return JSON.stringify([{ kind: "NO_TABS_PROBED" }]);
  }
  return JSON.stringify(probes);
}

async function ensureContentScriptReady(
  serviceWorker: Worker,
  options: { preferredPageUrl?: string; timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STATUS_POLL_TIMEOUT_MS;
  const startedAt = Date.now();
  let lastProbes: ContentScriptProbe[] = [];

  while (Date.now() - startedAt < timeoutMs) {
    const probeResult = await serviceWorker.evaluate(
      async (input: { protocolVersion: number; preferredPageUrl: string | null }) => {
        function normalizeComparableUrl(url: string): string {
          try {
            const parsed = new URL(url);
            const normalizedPathname =
              parsed.pathname.length > 1 && parsed.pathname.endsWith("/")
                ? parsed.pathname.slice(0, -1)
                : parsed.pathname;
            return `${parsed.origin}${normalizedPathname}`;
          } catch {
            return url;
          }
        }

        function isPreferredUrlCandidate(
          candidate: string | undefined | null,
          preferredPageUrl: string | null,
        ): boolean {
          if (typeof candidate !== "string" || preferredPageUrl === null) {
            return false;
          }
          if (
            candidate === preferredPageUrl ||
            candidate.startsWith(`${preferredPageUrl}?`) ||
            candidate.startsWith(`${preferredPageUrl}#`)
          ) {
            return true;
          }
          return normalizeComparableUrl(candidate) === normalizeComparableUrl(preferredPageUrl);
        }

        const allTabs = await chrome.tabs.query({});
        const preferredTabs =
          input.preferredPageUrl === null
            ? []
            : allTabs.filter((tab) =>
                [tab.url, tab.pendingUrl].some((candidate) =>
                  isPreferredUrlCandidate(candidate, input.preferredPageUrl),
                ),
              );
        const tabsToProbe =
          preferredTabs.length > 0
            ? preferredTabs
            : allTabs.filter((tab) => typeof tab.id === "number");

        const probes: ContentScriptProbe[] = [];
        let anyReady = false;

        for (const tab of tabsToProbe) {
          if (typeof tab.id !== "number") {
            continue;
          }

          let listenerReady = false;
          let listenerError: string | null = null;
          try {
            await chrome.tabs.sendMessage(tab.id, {
              v: input.protocolVersion,
              type: "GET_ANNOTATION_VISIBILITY",
            });
            listenerReady = true;
            anyReady = true;
          } catch (error: unknown) {
            listenerError = error instanceof Error ? error.message : String(error);
          }

          let injected = false;
          let injectError: string | null = null;
          if (!listenerReady) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["content/main.js"],
              });
              await chrome.scripting.insertCSS({
                target: { tabId: tab.id },
                files: ["content/annotations.css"],
              });
              injected = true;
            } catch (error: unknown) {
              injectError = error instanceof Error ? error.message : String(error);
            }
          }

          probes.push({
            tabId: tab.id,
            tabUrl: tab.url ?? null,
            pendingUrl: tab.pendingUrl ?? null,
            listenerReady,
            listenerError,
            injected,
            injectError,
          });
        }

        return {
          ready: anyReady,
          probes,
        };
      },
      {
        protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION,
        preferredPageUrl: options.preferredPageUrl ?? null,
      },
    );

    lastProbes = probeResult.probes;
    if (probeResult.ready) {
      return;
    }

    await sleep(200);
  }

  throw new Error(
    `Timed out waiting for content script listener (timeout ${timeoutMs}ms). Last probe results: ${summarizeContentScriptProbesForError(lastProbes)}`,
  );
}

async function getCachedStatuses(
  serviceWorker: Worker,
  options: { preferredPageUrl?: string } = {},
): Promise<CachedStatusProbe[]> {
  return serviceWorker.evaluate(
    async (input: { protocolVersion: number; preferredPageUrl: string | null }) => {
      function normalizeComparableUrl(url: string): string {
        try {
          const parsed = new URL(url);
          const normalizedPathname =
            parsed.pathname.length > 1 && parsed.pathname.endsWith("/")
              ? parsed.pathname.slice(0, -1)
              : parsed.pathname;
          return `${parsed.origin}${normalizedPathname}`;
        } catch {
          return url;
        }
      }

      function isPreferredUrlCandidate(
        candidate: string | undefined | null,
        preferredPageUrl: string | null,
      ): boolean {
        if (typeof candidate !== "string" || preferredPageUrl === null) {
          return false;
        }
        if (
          candidate === preferredPageUrl ||
          candidate.startsWith(`${preferredPageUrl}?`) ||
          candidate.startsWith(`${preferredPageUrl}#`)
        ) {
          return true;
        }
        return normalizeComparableUrl(candidate) === normalizeComparableUrl(preferredPageUrl);
      }

      const allTabs = await chrome.tabs.query({});

      const preferredTabs =
        input.preferredPageUrl === null
          ? []
          : allTabs.filter((tab) =>
              [tab.url, tab.pendingUrl].some((candidate) =>
                isPreferredUrlCandidate(candidate, input.preferredPageUrl),
              ),
            );

      const tabsToProbe =
        preferredTabs.length > 0
          ? preferredTabs
          : allTabs.filter((tab) => typeof tab.id === "number");

      const probes: {
        tabId: number;
        tabUrl: string | null;
        pendingUrl: string | null;
        status: unknown;
        error: string | null;
      }[] = [];

      for (const tab of tabsToProbe) {
        if (typeof tab.id !== "number") {
          continue;
        }

        try {
          // Trigger a refresh-cycle sync point in the content script before
          // reading cache so transient tab-cache clears can be repopulated.
          await chrome.tabs.sendMessage(tab.id, {
            v: input.protocolVersion,
            type: "GET_ANNOTATION_VISIBILITY",
          });
        } catch {
          // Ignore and continue to cached-status probing below.
        }

        try {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (messageProtocolVersion: number) => {
              const response = (await chrome.runtime.sendMessage({
                v: messageProtocolVersion,
                type: "GET_CACHED",
              })) as unknown;
              return response;
            },
            args: [input.protocolVersion],
          });

          probes.push({
            tabId: tab.id,
            tabUrl: tab.url ?? null,
            pendingUrl: tab.pendingUrl ?? null,
            status: result?.result ?? null,
            error: null,
          });
        } catch (error: unknown) {
          probes.push({
            tabId: tab.id,
            tabUrl: tab.url ?? null,
            pendingUrl: tab.pendingUrl ?? null,
            status: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return probes;
    },
    {
      protocolVersion: EXTENSION_MESSAGE_PROTOCOL_VERSION,
      preferredPageUrl: options.preferredPageUrl ?? null,
    },
  );
}

function hasMatchingSkippedStatus(status: unknown, expected: ExpectedSkippedStatus): boolean {
  const parsed = extensionPageStatusSchema.safeParse(status);
  if (!parsed.success || parsed.data.kind !== "SKIPPED") return false;
  if (expected.pageUrl !== undefined && parsed.data.pageUrl !== expected.pageUrl) {
    return false;
  }
  const acceptableReasons = Array.isArray(expected.reason) ? expected.reason : [expected.reason];
  return (
    parsed.data.platform === expected.platform &&
    parsed.data.externalId === expected.externalId &&
    acceptableReasons.includes(parsed.data.reason)
  );
}

function hasMatchingPostStatus(status: unknown, expected: ExpectedPostStatus): boolean {
  const parsed = extensionPageStatusSchema.safeParse(status);
  if (!parsed.success || parsed.data.kind !== "POST") return false;
  if (expected.pageUrl !== undefined && parsed.data.pageUrl !== expected.pageUrl) {
    return false;
  }
  if (
    expected.investigationState !== undefined &&
    parsed.data.investigationState !== expected.investigationState
  ) {
    return false;
  }
  return (
    parsed.data.platform === expected.platform && parsed.data.externalId === expected.externalId
  );
}

function summarizeStatusForError(status: unknown): string {
  const parsed = extensionPageStatusSchema.safeParse(status);
  if (!parsed.success) {
    return JSON.stringify({ kind: "UNPARSED", status });
  }

  if (parsed.data.kind === "SKIPPED") {
    return JSON.stringify({
      kind: "SKIPPED",
      platform: parsed.data.platform,
      externalId: parsed.data.externalId,
      reason: parsed.data.reason,
      pageUrl: parsed.data.pageUrl,
      tabSessionId: parsed.data.tabSessionId,
    });
  }

  return JSON.stringify({
    kind: "POST",
    platform: parsed.data.platform,
    externalId: parsed.data.externalId,
    investigationState: parsed.data.investigationState,
    pageUrl: parsed.data.pageUrl,
    tabSessionId: parsed.data.tabSessionId,
  });
}

function summarizeStatusProbesForError(probes: CachedStatusProbe[]): string {
  if (probes.length === 0) {
    return JSON.stringify([{ kind: "NO_TABS_PROBED" }]);
  }
  return JSON.stringify(
    probes.map((probe) => ({
      tabId: probe.tabId,
      tabUrl: probe.tabUrl,
      pendingUrl: probe.pendingUrl,
      error: probe.error,
      status: summarizeStatusForError(probe.status),
    })),
  );
}

async function waitForStatusMatch(
  readStatusProbes: () => Promise<CachedStatusProbe[]>,
  matches: (status: unknown) => boolean,
  timeoutMs: number,
  failureLabel: string,
): Promise<void> {
  const startedAt = Date.now();
  let lastProbes: CachedStatusProbe[] = [];
  while (Date.now() - startedAt < timeoutMs) {
    lastProbes = await readStatusProbes();
    if (lastProbes.some((probe) => matches(probe.status))) {
      return;
    }
    await sleep(250);
  }

  throw new Error(
    `${failureLabel} (timeout ${timeoutMs}ms). Last cached statuses: ${summarizeStatusProbesForError(lastProbes)}`,
  );
}

async function expectSkippedStatus(
  serviceWorker: Worker,
  expected: ExpectedSkippedStatus,
  options: { timeoutMs?: number; preferredPageUrl?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STATUS_POLL_TIMEOUT_MS;
  const preferredPageUrl = options.preferredPageUrl ?? expected.pageUrl;
  const probeOptions = preferredPageUrl === undefined ? {} : { preferredPageUrl };
  await ensureContentScriptReady(serviceWorker, {
    timeoutMs,
    ...probeOptions,
  });
  await waitForStatusMatch(
    () => getCachedStatuses(serviceWorker, probeOptions),
    (status) => hasMatchingSkippedStatus(status, expected),
    timeoutMs,
    `Expected skipped status did not match ${JSON.stringify(expected)}`,
  );
}

async function expectPostStatus(
  serviceWorker: Worker,
  expected: ExpectedPostStatus,
  options: { timeoutMs?: number; preferredPageUrl?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STATUS_POLL_TIMEOUT_MS;
  const preferredPageUrl = options.preferredPageUrl ?? expected.pageUrl;
  const probeOptions = preferredPageUrl === undefined ? {} : { preferredPageUrl };
  await ensureContentScriptReady(serviceWorker, {
    timeoutMs,
    ...probeOptions,
  });
  await waitForStatusMatch(
    () => getCachedStatuses(serviceWorker, probeOptions),
    (status) => hasMatchingPostStatus(status, expected),
    timeoutMs,
    `Expected post status did not match ${JSON.stringify(expected)}`,
  );
}

function injectVideoIntoWikipediaFixtureHtml(html: string): string {
  const marker = '<div class="mw-parser-output">';
  const videoNode =
    '<video controls src="https://upload.wikimedia.org/openerrata-e2e-video.mp4"></video>';
  if (html.includes(marker)) {
    return html.replace(marker, `${marker}${videoNode}`);
  }

  const bodyEnd = "</body>";
  if (html.includes(bodyEnd)) {
    return html.replace(bodyEnd, `${videoNode}${bodyEnd}`);
  }

  return `${html}${videoNode}`;
}
async function launchExtensionHarness(): Promise<ExtensionHarness> {
  const extensionPath = resolve(process.cwd(), "dist");
  const userDataDir = mkdtempSync(join(tmpdir(), "openerrata-extension-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // Chromium does not reliably load extension service workers in headless mode.
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });

  const serviceWorker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));

  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.clear();
  });

  return { context, serviceWorker, userDataDir };
}

async function closeExtensionHarness(harness: ExtensionHarness): Promise<void> {
  await harness.context.close();
  rmSync(harness.userDataDir, { recursive: true, force: true });
}

test("LessWrong post URL without slug still reaches a terminal skipped status", async () => {
  const harness = await launchExtensionHarness();
  try {
    const postId = "qefrWyeiMvWEFRitN";
    const url = `https://www.lesswrong.com/posts/${postId}`;
    const page = await harness.context.newPage();

    await page.route(`${url}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>LessWrong test post</title></head>
  <body>
    <div id="postBody">
      <script type="application/ld+json">
        {"url":"https://www.lesswrong.com/posts/${postId}"}
      </script>
      <h1>LessWrong test post</h1>
      <article class="PostsPage-postContent">
        <div id="postContent">
          <p>This test post includes video-only media.</p>
          <video controls src="https://example.com/video.mp4"></video>
        </div>
      </article>
    </div>
  </body>
</html>`,
      });
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(
      harness.serviceWorker,
      {
        platform: "LESSWRONG",
        externalId: postId,
        reason: "has_video",
      },
      { preferredPageUrl: url },
    );
  } finally {
    await closeExtensionHarness(harness);
  }
});

test("X i/status URL still reaches a terminal skipped status", async () => {
  const harness = await launchExtensionHarness();
  try {
    const tweetId = "1234567890123456789";
    const url = `https://x.com/i/status/${tweetId}`;
    const page = await harness.context.newPage();

    await page.route(`${url}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta property="og:url" content="https://x.com/openerrata/status/${tweetId}" />
    <title>X test status</title>
  </head>
  <body>
    <article>
      <div data-testid="User-Name">
        <a href="/openerrata/status/${tweetId}"><span>OpenErrata</span></a>
        <span>@openerrata</span>
      </div>
      <div data-testid="tweetText">This tweet includes video-only media for eligibility checks.</div>
      <div data-testid="videoPlayer"><video src="https://video.twimg.com/test.mp4"></video></div>
      <time datetime="2026-02-20T00:00:00.000Z"></time>
    </article>
  </body>
</html>`,
      });
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(
      harness.serviceWorker,
      {
        platform: "X",
        externalId: tweetId,
        reason: "has_video",
      },
      { preferredPageUrl: url },
    );
  } finally {
    await closeExtensionHarness(harness);
  }
});

test("X protected status stays private_or_gated even with unrelated tweet text on page", async () => {
  const harness = await launchExtensionHarness();
  try {
    const tweetId = "987654321098765432";
    const url = `https://x.com/i/status/${tweetId}`;
    const page = await harness.context.newPage();

    await page.route(`${url}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>X protected status</title>
  </head>
  <body>
    <div data-testid="primaryColumn">
      <div data-testid="error-detail">These posts are protected. Only confirmed followers have access.</div>
    </div>
    <article>
      <div data-testid="User-Name">
        <a href="/other/status/1111111111111111111"><span>Other User</span></a>
        <span>@other</span>
      </div>
      <div data-testid="tweetText">This is unrelated timeline text and must not be extracted for the protected status.</div>
    </article>
  </body>
</html>`,
      });
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(
      harness.serviceWorker,
      {
        platform: "X",
        externalId: tweetId,
        reason: "private_or_gated",
      },
      { preferredPageUrl: url },
    );
  } finally {
    await closeExtensionHarness(harness);
  }
});

test("X i/web/status permalink anchors are accepted for target tweet extraction", async () => {
  const harness = await launchExtensionHarness();
  try {
    const tweetId = "112233445566778899";
    const url = `https://x.com/i/web/status/${tweetId}`;
    const page = await harness.context.newPage();

    await page.route(`${url}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>X i/web status</title>
  </head>
  <body>
    <article>
      <div data-testid="User-Name">
        <a href="/openerrata"><span>OpenErrata</span></a>
        <span>@openerrata</span>
      </div>
      <div data-testid="tweetText">This tweet includes video-only media for eligibility checks.</div>
      <div data-testid="videoPlayer"><video src="https://video.twimg.com/test.mp4"></video></div>
      <a href="/i/web/status/${tweetId}">
        <time datetime="2026-02-20T00:00:00.000Z">4:00 PM · Feb 20, 2026</time>
      </a>
    </article>
  </body>
</html>`,
      });
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(
      harness.serviceWorker,
      {
        platform: "X",
        externalId: tweetId,
        reason: "has_video",
      },
      { preferredPageUrl: url },
    );
  } finally {
    await closeExtensionHarness(harness);
  }
});

test("X single-article fallback is allowed when canonical identity proves target tweet", async () => {
  const harness = await launchExtensionHarness();
  try {
    const tweetId = "223344556677889900";
    const url = `https://x.com/i/status/${tweetId}`;
    const page = await harness.context.newPage();

    await page.route(`${url}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta property="og:url" content="https://x.com/openerrata/status/${tweetId}" />
    <title>X i/status single-article fallback</title>
  </head>
  <body>
    <div data-testid="primaryColumn">
      <article>
        <div data-testid="User-Name">
          <a href="/openerrata"><span>OpenErrata</span></a>
          <span>@openerrata</span>
        </div>
        <div data-testid="tweetText">Single article content tied to target by canonical metadata.</div>
        <div data-testid="videoPlayer"><video src="https://video.twimg.com/test.mp4"></video></div>
      </article>
    </div>
  </body>
</html>`,
      });
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(
      harness.serviceWorker,
      {
        platform: "X",
        externalId: tweetId,
        reason: "has_video",
      },
      { preferredPageUrl: url },
    );
  } finally {
    await closeExtensionHarness(harness);
  }
});

test("X status routes require identity proof and eventually skip when proof never appears", async () => {
  const harness = await launchExtensionHarness();
  try {
    const tweetId = "998877665544332211";
    const url = `https://x.com/i/status/${tweetId}`;
    const page = await harness.context.newPage();

    await page.route(`${url}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>X i/status without identity proof</title>
  </head>
  <body>
    <div data-testid="primaryColumn">
      <article>
        <div data-testid="User-Name">
          <a href="/other"><span>Other User</span></a>
          <span>@other</span>
        </div>
        <div data-testid="tweetText">Timeline text that is not proven to belong to the requested status.</div>
      </article>
    </div>
  </body>
</html>`,
      });
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(
      harness.serviceWorker,
      {
        platform: "X",
        externalId: tweetId,
        reason: "unsupported_content",
      },
      { preferredPageUrl: url },
    );
  } finally {
    await closeExtensionHarness(harness);
  }
});

test("Substack paywalled post reaches a private_or_gated skipped status", async () => {
  const harness = await launchExtensionHarness();
  try {
    const slug = "paid-post";
    const url = `https://example.substack.com/p/${slug}`;
    const page = await harness.context.newPage();

    await page.route(`${url}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Substack paid post</title>
  </head>
  <body>
    <main>
      <div class="paywall">
        <p>This post is for paid subscribers</p>
        <a href="/subscribe">Subscribe to continue reading</a>
      </div>
    </main>
  </body>
</html>`,
      });
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(
      harness.serviceWorker,
      {
        platform: "SUBSTACK",
        externalId: slug,
        reason: "private_or_gated",
      },
      { preferredPageUrl: url },
    );
  } finally {
    await closeExtensionHarness(harness);
  }
});

test("Substack public post with subscribe CTA is not misclassified as private_or_gated", async () => {
  const harness = await launchExtensionHarness();
  try {
    const slug = "public-post";
    const postId = "123456789";
    const url = `https://example.substack.com/p/${slug}`;
    const page = await harness.context.newPage();

    await page.route(`${url}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Substack public post</title>
    <meta name="author" content="Example Author" />
    <meta name="twitter:image" content="https://substackcdn.com/image/fetch/w_1456,c_limit,f_jpg,q_auto:good,fl_progressive:steep/https%3A%2F%2Fexample.substack.com%2Fpost_preview%2F${postId}%2Ftwitter.jpg" />
  </head>
  <body>
    <main>
      <h1 class="post-title">A Public Substack Post</h1>
      <div class="body markup">
        <p>This is a normal public post with enough text for extraction.</p>
        <p>It should be treated as content and not as a private or gated view.</p>
      </div>
      <section class="newsletter-cta">
        <p>Subscribe to continue reading</p>
        <a href="/subscribe">Subscribe</a>
      </section>
    </main>
  </body>
</html>`,
      });
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectPostStatus(harness.serviceWorker, {
      platform: "SUBSTACK",
      externalId: postId,
      pageUrl: url,
    });
  } finally {
    await closeExtensionHarness(harness);
  }
});

test("Substack private_or_gated state updates when origin changes but slug stays the same", async () => {
  const harness = await launchExtensionHarness();
  try {
    const slug = "paid-post";
    const firstUrl = `https://alpha.substack.com/p/${slug}`;
    const secondUrl = `https://beta.substack.com/p/${slug}`;
    const page = await harness.context.newPage();

    await page.route(`${firstUrl}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Alpha paywalled post</title></head>
  <body>
    <main>
      <div class="paywall">
        <p>This post is for paid subscribers</p>
        <a href="/subscribe">Subscribe to continue reading</a>
      </div>
    </main>
  </body>
</html>`,
      });
    });

    await page.route(`${secondUrl}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Beta paywalled post</title></head>
  <body>
    <main>
      <div class="paywall">
        <p>This post is for paid subscribers</p>
        <a href="/subscribe">Subscribe to continue reading</a>
      </div>
    </main>
  </body>
</html>`,
      });
    });

    await page.goto(firstUrl, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(harness.serviceWorker, {
      platform: "SUBSTACK",
      externalId: slug,
      reason: "private_or_gated",
      pageUrl: firstUrl,
    });

    await page.goto(secondUrl, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(harness.serviceWorker, {
      platform: "SUBSTACK",
      externalId: slug,
      reason: "private_or_gated",
      pageUrl: secondUrl,
    });
  } finally {
    await closeExtensionHarness(harness);
  }
});

test("Wikipedia cached live-page fixture reaches a terminal skipped status", async () => {
  const harness = await launchExtensionHarness();
  try {
    const fixture = await readE2eWikipediaFixture(
      E2E_WIKIPEDIA_FIXTURE_KEYS.ALI_KHAMENEI_PAGE_HTML,
    );
    const url = fixture.sourceUrl;
    const page = await harness.context.newPage();
    const html = injectVideoIntoWikipediaFixtureHtml(fixture.html);

    await page.route(`${url}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: html,
      });
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    // The fixture has injected video AND exceeds the 10K word count limit,
    // so either skip reason is valid. The test verifies that the extension
    // reaches a terminal SKIPPED status for this article without depending
    // on which skip condition is evaluated first.
    await expectSkippedStatus(harness.serviceWorker, {
      platform: "WIKIPEDIA",
      externalId: `${fixture.language}:${fixture.pageId}`,
      reason: ["has_video", "word_count"],
      pageUrl: url,
    });
  } finally {
    await closeExtensionHarness(harness);
  }
});
