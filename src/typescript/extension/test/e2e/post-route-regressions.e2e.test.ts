import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  extensionPageStatusSchema,
  type ExtensionPostStatus,
  type ExtensionSkippedReason,
} from "@openerrata/shared";
import { chromium, expect, test, type BrowserContext, type Worker } from "@playwright/test";

type Platform = "LESSWRONG" | "X" | "SUBSTACK";

interface ExtensionHarness {
  context: BrowserContext;
  serviceWorker: Worker;
  userDataDir: string;
}

interface ExpectedSkippedStatus {
  platform: Platform;
  externalId: string;
  reason: ExtensionSkippedReason;
  pageUrl?: string;
}

interface ExpectedPostStatus {
  platform: Platform;
  externalId: string;
  pageUrl?: string;
  investigationState?: ExtensionPostStatus["investigationState"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMatchingSkippedStatus(
  status: unknown,
  expected: ExpectedSkippedStatus,
): boolean {
  const parsed = extensionPageStatusSchema.safeParse(status);
  if (!parsed.success || parsed.data.kind !== "SKIPPED") return false;
  if (expected.pageUrl !== undefined && parsed.data.pageUrl !== expected.pageUrl) {
    return false;
  }
  return (
    parsed.data.platform === expected.platform &&
    parsed.data.externalId === expected.externalId &&
    parsed.data.reason === expected.reason
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
    parsed.data.platform === expected.platform &&
    parsed.data.externalId === expected.externalId
  );
}

async function launchExtensionHarness(): Promise<ExtensionHarness> {
  const extensionPath = resolve(process.cwd(), "dist");
  const userDataDir = mkdtempSync(join(tmpdir(), "openerrata-extension-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker");
  }

  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.clear();
  });

  return { context, serviceWorker, userDataDir };
}

async function closeExtensionHarness(harness: ExtensionHarness): Promise<void> {
  await harness.context.close();
  rmSync(harness.userDataDir, { recursive: true, force: true });
}

async function expectSkippedStatus(
  serviceWorker: Worker,
  expected: ExpectedSkippedStatus,
): Promise<void> {
  await expect
    .poll(async () => {
      const records = await serviceWorker.evaluate(async () => {
        const storageSnapshot = await chrome.storage.local.get(null);
        return Object.values(storageSnapshot);
      });

      if (!Array.isArray(records)) {
        return false;
      }

      for (const record of records) {
        if (!isRecord(record)) continue;
        const skippedStatus = record["skippedStatus"];
        if (hasMatchingSkippedStatus(skippedStatus, expected)) {
          return true;
        }
      }

      return false;
    })
    .toBe(true);
}

async function expectPostStatus(
  serviceWorker: Worker,
  expected: ExpectedPostStatus,
): Promise<void> {
  await expect
    .poll(async () => {
      const records = await serviceWorker.evaluate(async () => {
        const storageSnapshot = await chrome.storage.local.get(null);
        return Object.values(storageSnapshot);
      });

      if (!Array.isArray(records)) {
        return false;
      }

      for (const record of records) {
        if (!isRecord(record)) continue;
        const activePostStatus = record["activePostStatus"];
        if (hasMatchingPostStatus(activePostStatus, expected)) {
          return true;
        }
      }

      return false;
    })
    .toBe(true);
}

test("LessWrong post URL without slug still reaches a terminal skipped status", async () => {
  const harness = await launchExtensionHarness();
  try {
    const postId = "qefrWyeiMvWEFRitN";
    const url = `https://www.lesswrong.com/posts/${postId}`;
    const page = await harness.context.newPage();

    await page.route(`${url}*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>LessWrong test post</title></head>
  <body>
    <h1>LessWrong test post</h1>
    <article class="PostsPage-postContent">
      <p>This test post includes video-only media.</p>
      <video controls src="https://example.com/video.mp4"></video>
    </article>
  </body>
</html>`,
      });
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(harness.serviceWorker, {
      platform: "LESSWRONG",
      externalId: postId,
      reason: "video_only",
    });
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

    await page.route(`${url}*`, async (route) => {
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
    await expectSkippedStatus(harness.serviceWorker, {
      platform: "X",
      externalId: tweetId,
      reason: "video_only",
    });
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

    await page.route(`${url}*`, async (route) => {
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
    await expectSkippedStatus(harness.serviceWorker, {
      platform: "X",
      externalId: tweetId,
      reason: "private_or_gated",
    });
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

    await page.route(`${url}*`, async (route) => {
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
    await expectSkippedStatus(harness.serviceWorker, {
      platform: "SUBSTACK",
      externalId: slug,
      reason: "private_or_gated",
    });
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

    await page.route(`${url}*`, async (route) => {
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

    await page.route(`${firstUrl}*`, async (route) => {
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

    await page.route(`${secondUrl}*`, async (route) => {
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

test("sanity: extension service worker is loaded", async () => {
  const harness = await launchExtensionHarness();
  try {
    const serviceWorkerUrl = harness.serviceWorker.url();
    assert.ok(serviceWorkerUrl.includes("chrome-extension://"));
  } finally {
    await closeExtensionHarness(harness);
  }
});
