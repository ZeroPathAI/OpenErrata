import { expect, test } from "@playwright/test";
import { wikipediaHtmlToNormalizedText } from "../../../api/src/lib/services/content-fetcher.js";
import {
  defaultApiOutput,
  launchExtensionHarness,
  pingContentScript,
  readCachedStatus,
  servePage,
  sleep,
  waitFor,
  waitForCachedStatus,
  type RecordedApiCall,
} from "./extension-harness.js";
import { E2E_WIKIPEDIA_FIXTURE_KEYS, readE2eWikipediaFixture } from "./wikipedia-fixtures.js";

const CLAIM_TEXT = "The moon is made of cheese";

const claim = {
  id: "claim-moon-cheese",
  text: CLAIM_TEXT,
  context: `${CLAIM_TEXT}, according to this post.`,
  summary: "The moon is rock, not cheese.",
  reasoning: "Lunar samples are basaltic rock.",
  sources: [{ url: "https://example.com/moon", title: "Moon geology", snippet: "Basalt." }],
};

function lesswrongPostHtml(postId: string, paragraphs: readonly string[]): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Moon post</title></head>
  <body>
    <div id="postBody">
      <script type="application/ld+json">{"url":"https://www.lesswrong.com/posts/${postId}"}</script>
      <h1>Moon post</h1>
      <div class="PostsPage-postContent">
        <div id="postContent">${paragraphs.map((text) => `<p>${text}</p>`).join("")}</div>
      </div>
    </div>
  </body>
</html>`;
}

function substackPostHtml(postId: string, body: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Moon post</title>
    <meta name="author" content="Example Author" />
    <meta name="twitter:image" content="https://substackcdn.com/image/fetch/w_1456/https%3A%2F%2Fexample.substack.com%2Fpost_preview%2F${postId}%2Ftwitter.jpg" />
  </head>
  <body>
    <h1 class="post-title">Moon post</h1>
    <div class="body markup"><p>${body}</p></div>
  </body>
</html>`;
}

function registerCalls(calls: readonly RecordedApiCall[]): RecordedApiCall[] {
  return calls.filter((call) => call.path === "post.registerObservedVersion");
}

test("a post someone else is investigating is followed until its claims arrive", async () => {
  let polls = 0;
  const harness = await launchExtensionHarness((call) => {
    if (call.path === "post.getInvestigation") {
      polls += 1;
      return polls < 2
        ? {
            investigationState: "INVESTIGATING",
            status: "PROCESSING",
            provenance: "CLIENT_FALLBACK",
            pendingClaims: [],
            confirmedClaims: [],
            priorInvestigationResult: null,
          }
        : {
            investigationState: "INVESTIGATED",
            provenance: "CLIENT_FALLBACK",
            claims: [claim],
            checkedAt: "2026-10-02T00:00:00.000Z",
          };
    }
    // The investigation was queued by another viewer: this tab never called investigateNow.
    return defaultApiOutput(call, {
      investigationState: "INVESTIGATING",
      investigationId: "investigation-queued-elsewhere",
      status: "PENDING",
      provenance: "CLIENT_FALLBACK",
      pendingClaims: [],
      confirmedClaims: [],
      priorInvestigationResult: null,
    });
  });
  try {
    const url = "https://example.substack.com/p/moon-post";
    const page = await harness.context.newPage();
    await servePage(
      page,
      url,
      substackPostHtml("424242", `${CLAIM_TEXT}, according to this post.`),
    );
    await page.goto(url, { waitUntil: "domcontentloaded" });

    await waitForCachedStatus(
      harness,
      url,
      (status) => status.kind === "POST" && status.investigationState === "INVESTIGATING",
      "the INVESTIGATING status reported by the API",
    );
    const settled = await waitForCachedStatus(
      harness,
      url,
      (status) => status.kind === "POST" && status.investigationState === "INVESTIGATED",
      "polling to reach the completed investigation",
      20_000,
    );
    expect(settled.kind === "POST" && settled.investigationState === "INVESTIGATED").toBe(true);
    expect(
      harness.apiCalls.some(
        (call) =>
          call.path === "post.getInvestigation" &&
          JSON.stringify(call.input).includes("investigation-queued-elsewhere"),
      ),
    ).toBe(true);
    expect(harness.apiCalls.some((call) => call.path === "post.investigateNow")).toBe(false);
    await expect(page.locator(`mark[data-openerrata-claim-id="${claim.id}"]`)).toHaveCount(1);
  } finally {
    await harness.close();
  }
});

test("injecting the content script again leaves the one live page session in place", async () => {
  const harness = await launchExtensionHarness();
  try {
    const postId = "idempotentInjection1";
    const url = `https://www.lesswrong.com/posts/${postId}/moon`;
    const page = await harness.context.newPage();
    await servePage(
      page,
      url,
      lesswrongPostHtml(postId, [`${CLAIM_TEXT}, according to this post.`]),
    );
    await page.goto(url, { waitUntil: "domcontentloaded" });

    await waitForCachedStatus(harness, url, (status) => status.kind === "POST", "a post status");
    const sessionBefore = await readCachedStatus(harness.serviceWorker, url);
    expect(registerCalls(harness.apiCalls)).toHaveLength(1);

    // What the background does for tabs it finds without a live listener, and
    // what a racing DOMContentLoaded/declarative injection amounts to.
    await harness.serviceWorker.evaluate(async (pageUrl: string) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      if (tab?.id === undefined) throw new Error("tab not found");
      for (let copy = 0; copy < 2; copy += 1) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content/main.js"],
        });
      }
    }, url);
    await sleep(1_500);

    expect(await pingContentScript(harness.serviceWorker, url)).toBe(true);
    expect(registerCalls(harness.apiCalls)).toHaveLength(1);
    expect(await readCachedStatus(harness.serviceWorker, url)).toEqual(sessionBefore);
  } finally {
    await harness.close();
  }
});

test("highlight marks never reach the API in page HTML", async () => {
  const harness = await launchExtensionHarness((call) =>
    defaultApiOutput(call, {
      investigationState: "INVESTIGATED",
      investigationId: "investigation-moon",
      provenance: "SERVER_VERIFIED",
      claims: [claim],
    }),
  );
  try {
    const postId = "marksNeverSent1";
    const url = `https://www.lesswrong.com/posts/${postId}/moon`;
    const page = await harness.context.newPage();
    await servePage(
      page,
      url,
      lesswrongPostHtml(postId, [`${CLAIM_TEXT}, according to this post.`]),
    );
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expect(page.locator("mark.openerrata-annotation")).toHaveCount(1);

    // Edit the post while the highlight is on the page: the new version is
    // registered with HTML read from the highlighted DOM.
    await page.evaluate(() => {
      const paragraph = document.createElement("p");
      paragraph.textContent = "An added paragraph.";
      document.querySelector("#postContent")?.appendChild(paragraph);
    });
    const calls = await waitFor(
      "the edited version to be registered",
      () => Promise.resolve(registerCalls(harness.apiCalls)),
      (registered) => registered.length >= 2,
    );

    const htmlSent = calls.map((call) => JSON.stringify(call.input));
    expect(htmlSent[1]).toContain("An added paragraph.");
    for (const html of htmlSent) {
      expect(html).not.toContain("openerrata");
      expect(html).not.toContain("<mark");
    }
  } finally {
    await harness.close();
  }
});

test("a History API navigation the page makes is seen by the content script", async () => {
  const harness = await launchExtensionHarness();
  try {
    const postId = "historyNavigation1";
    const url = `https://www.lesswrong.com/posts/${postId}/moon`;
    const page = await harness.context.newPage();
    await servePage(
      page,
      url,
      lesswrongPostHtml(postId, [`${CLAIM_TEXT}, according to this post.`]),
    );
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitForCachedStatus(harness, url, (status) => status.kind === "POST", "a post status");

    // A page-world pushState with no DOM change: only the background's
    // webNavigation relay can tell the isolated content script about it.
    await page.evaluate(() => {
      history.pushState({}, "", "/about");
    });
    await waitFor(
      "the post session to end after navigating away from the post",
      () =>
        harness.serviceWorker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ url: "https://www.lesswrong.com/about" });
          if (tab?.id === undefined) return "no-tab";
          const key = `tab:${tab.id.toString()}`;
          const record = await chrome.storage.session.get(key);
          return record[key] === undefined ? "cleared" : "cached";
        }),
      (state) => state === "cleared",
    );
  } finally {
    await harness.close();
  }
});

test("Wikipedia text the extension reports matches the API's canonical text", async () => {
  const fixture = await readE2eWikipediaFixture(E2E_WIKIPEDIA_FIXTURE_KEYS.OPENAI_PAGE_HTML);
  const harness = await launchExtensionHarness();
  try {
    const page = await harness.context.newPage();
    await servePage(page, fixture.sourceUrl, fixture.html);
    // Wikipedia's own scripts load from the network and modify the article
    // DOM; the extension must exclude what they add.
    await page.goto(fixture.sourceUrl, { waitUntil: "networkidle" });

    const [registered] = await waitFor(
      "the article to be registered",
      () => Promise.resolve(registerCalls(harness.apiCalls)),
      (calls) => calls.length >= 1,
    );
    const input = registered?.input as { observedContentText: string };
    expect(input.observedContentText).toEqual(wikipediaHtmlToNormalizedText(fixture.parseApiHtml));
  } finally {
    await harness.close();
  }
});
