import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  extensionPageStatusSchema,
  type ExtensionSkippedReason,
} from "@truesight/shared";
import { chromium, expect, test, type BrowserContext, type Worker } from "@playwright/test";

type Platform = "LESSWRONG" | "X";

interface ExtensionHarness {
  context: BrowserContext;
  serviceWorker: Worker;
  userDataDir: string;
}

interface ExpectedSkippedStatus {
  platform: Platform;
  externalId: string;
  reason: ExtensionSkippedReason;
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
  return (
    parsed.data.platform === expected.platform &&
    parsed.data.externalId === expected.externalId &&
    parsed.data.reason === expected.reason
  );
}

async function launchExtensionHarness(): Promise<ExtensionHarness> {
  const extensionPath = resolve(process.cwd(), "dist");
  const userDataDir = mkdtempSync(join(tmpdir(), "truesight-extension-e2e-"));
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
    <meta property="og:url" content="https://x.com/truesight/status/${tweetId}" />
    <title>X test status</title>
  </head>
  <body>
    <article>
      <div data-testid="User-Name">
        <a href="/truesight/status/${tweetId}"><span>TrueSight</span></a>
        <span>@truesight</span>
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

test("sanity: extension service worker is loaded", async () => {
  const harness = await launchExtensionHarness();
  try {
    const serviceWorkerUrl = harness.serviceWorker.url();
    assert.ok(serviceWorkerUrl.includes("chrome-extension://"));
  } finally {
    await closeExtensionHarness(harness);
  }
});
