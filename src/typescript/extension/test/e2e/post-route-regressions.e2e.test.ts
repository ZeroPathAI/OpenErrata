import type { ExtensionSkippedReason, Platform } from "@openerrata/shared";
import { test } from "@playwright/test";
import {
  launchExtensionHarness,
  servePage,
  waitForCachedStatus,
  type ExtensionHarness,
} from "./extension-harness.js";
import { E2E_WIKIPEDIA_FIXTURE_KEYS, readE2eWikipediaFixture } from "./wikipedia-fixtures.js";

interface ExpectedSkippedStatus {
  platform: Platform;
  /** A single reason or array of acceptable reasons (when multiple skip conditions apply). */
  reason: ExtensionSkippedReason | ExtensionSkippedReason[];
  pageUrl: string;
}

interface ExpectedPostStatus {
  platform: Platform;
  externalId: string;
  pageUrl: string;
}

async function expectSkippedStatus(
  harness: ExtensionHarness,
  expected: ExpectedSkippedStatus,
): Promise<void> {
  const acceptableReasons = Array.isArray(expected.reason) ? expected.reason : [expected.reason];
  await waitForCachedStatus(
    harness,
    expected.pageUrl,
    (status) =>
      status.kind === "SKIPPED" &&
      status.platform === expected.platform &&
      status.pageUrl === expected.pageUrl &&
      acceptableReasons.includes(status.reason),
    `skipped status ${JSON.stringify(expected)}`,
  );
}

async function expectPostStatus(
  harness: ExtensionHarness,
  expected: ExpectedPostStatus,
): Promise<void> {
  await waitForCachedStatus(
    harness,
    expected.pageUrl,
    (status) =>
      status.kind === "POST" &&
      status.platform === expected.platform &&
      status.externalId === expected.externalId &&
      status.pageUrl === expected.pageUrl,
    `post status ${JSON.stringify(expected)}`,
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

test("LessWrong post URL without slug still reaches a terminal skipped status", async () => {
  const harness = await launchExtensionHarness();
  try {
    const postId = "qefrWyeiMvWEFRitN";
    const url = `https://www.lesswrong.com/posts/${postId}`;
    const page = await harness.context.newPage();

    await servePage(
      page,
      url,
      `<!doctype html>
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
    );

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(harness, {
      platform: "LESSWRONG",
      reason: "has_video",
      pageUrl: url,
    });
  } finally {
    await harness.close();
  }
});

test("X i/status URL still reaches a terminal skipped status", async () => {
  const harness = await launchExtensionHarness();
  try {
    const tweetId = "1234567890123456789";
    const url = `https://x.com/i/status/${tweetId}`;
    const page = await harness.context.newPage();

    await servePage(
      page,
      url,
      `<!doctype html>
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
    );

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(harness, {
      platform: "X",
      reason: "has_video",
      pageUrl: url,
    });
  } finally {
    await harness.close();
  }
});

test("X protected status stays private_or_gated even with unrelated tweet text on page", async () => {
  const harness = await launchExtensionHarness();
  try {
    const tweetId = "987654321098765432";
    const url = `https://x.com/i/status/${tweetId}`;
    const page = await harness.context.newPage();

    await servePage(
      page,
      url,
      `<!doctype html>
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
    );

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(harness, {
      platform: "X",
      reason: "private_or_gated",
      pageUrl: url,
    });
  } finally {
    await harness.close();
  }
});

test("X i/web/status permalink anchors are accepted for target tweet extraction", async () => {
  const harness = await launchExtensionHarness();
  try {
    const tweetId = "112233445566778899";
    const url = `https://x.com/i/web/status/${tweetId}`;
    const page = await harness.context.newPage();

    await servePage(
      page,
      url,
      `<!doctype html>
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
    );

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(harness, {
      platform: "X",
      reason: "has_video",
      pageUrl: url,
    });
  } finally {
    await harness.close();
  }
});

test("X single-article fallback is allowed when canonical identity proves target tweet", async () => {
  const harness = await launchExtensionHarness();
  try {
    const tweetId = "223344556677889900";
    const url = `https://x.com/i/status/${tweetId}`;
    const page = await harness.context.newPage();

    await servePage(
      page,
      url,
      `<!doctype html>
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
    );

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(harness, {
      platform: "X",
      reason: "has_video",
      pageUrl: url,
    });
  } finally {
    await harness.close();
  }
});

test("X status routes require identity proof and eventually skip when proof never appears", async () => {
  const harness = await launchExtensionHarness();
  try {
    const tweetId = "998877665544332211";
    const url = `https://x.com/i/status/${tweetId}`;
    const page = await harness.context.newPage();

    await servePage(
      page,
      url,
      `<!doctype html>
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
    );

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(harness, {
      platform: "X",
      reason: "unsupported_content",
      pageUrl: url,
    });
  } finally {
    await harness.close();
  }
});

test("Substack paywalled post reaches a private_or_gated skipped status", async () => {
  const harness = await launchExtensionHarness();
  try {
    const slug = "paid-post";
    const url = `https://example.substack.com/p/${slug}`;
    const page = await harness.context.newPage();

    await servePage(
      page,
      url,
      `<!doctype html>
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
    );

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(harness, {
      platform: "SUBSTACK",
      reason: "private_or_gated",
      pageUrl: url,
    });
  } finally {
    await harness.close();
  }
});

test("Substack public post with subscribe CTA is not misclassified as private_or_gated", async () => {
  const harness = await launchExtensionHarness();
  try {
    const slug = "public-post";
    const postId = "123456789";
    const url = `https://example.substack.com/p/${slug}`;
    const page = await harness.context.newPage();

    await servePage(
      page,
      url,
      `<!doctype html>
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
    );

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expectPostStatus(harness, {
      platform: "SUBSTACK",
      externalId: postId,
      pageUrl: url,
    });
  } finally {
    await harness.close();
  }
});

test("Substack private_or_gated state updates when origin changes but slug stays the same", async () => {
  const harness = await launchExtensionHarness();
  try {
    const slug = "paid-post";
    const firstUrl = `https://alpha.substack.com/p/${slug}`;
    const secondUrl = `https://beta.substack.com/p/${slug}`;
    const page = await harness.context.newPage();

    await servePage(
      page,
      firstUrl,
      `<!doctype html>
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
    );

    await servePage(
      page,
      secondUrl,
      `<!doctype html>
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
    );

    await page.goto(firstUrl, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(harness, {
      platform: "SUBSTACK",
      reason: "private_or_gated",
      pageUrl: firstUrl,
    });

    await page.goto(secondUrl, { waitUntil: "domcontentloaded" });
    await expectSkippedStatus(harness, {
      platform: "SUBSTACK",
      reason: "private_or_gated",
      pageUrl: secondUrl,
    });
  } finally {
    await harness.close();
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

    await servePage(page, url, html);

    await page.goto(url, { waitUntil: "domcontentloaded" });
    // The fixture has injected video AND exceeds the 10K word count limit,
    // so either skip reason is valid. The test verifies that the extension
    // reaches a terminal SKIPPED status for this article without depending
    // on which skip condition is evaluated first.
    await expectSkippedStatus(harness, {
      platform: "WIKIPEDIA",
      reason: ["has_video", "word_count"],
      pageUrl: url,
    });
  } finally {
    await harness.close();
  }
});
