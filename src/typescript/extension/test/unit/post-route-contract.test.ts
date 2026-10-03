import assert from "node:assert/strict";
import { test } from "node:test";
import { selectAdapter } from "../../src/content/adapters/index";
import {
  isPossibleCustomDomainSubstackPage,
  isSamePage,
  knownHostPageLocator,
  pageLocatorFor,
  pageLocatorKey,
  type PageLocator,
} from "../../src/lib/page-locator";
import { withDom } from "../helpers/dom";

const supportedCases: { url: string; locator: PageLocator }[] = [
  {
    url: "https://www.lesswrong.com/posts/qefrWyeiMvWEFRitN",
    locator: { platform: "LESSWRONG", postId: "qefrWyeiMvWEFRitN", slug: null },
  },
  {
    url: "https://www.lesswrong.com/posts/qefrWyeiMvWEFRitN/be-skeptical?commentId=abc",
    locator: { platform: "LESSWRONG", postId: "qefrWyeiMvWEFRitN", slug: "be-skeptical" },
  },
  {
    url: "https://x.com/example/status/1234567890123456789",
    locator: { platform: "X", tweetId: "1234567890123456789", authorHandle: "example" },
  },
  {
    url: "https://twitter.com/i/web/status/1234567890123456789",
    locator: { platform: "X", tweetId: "1234567890123456789", authorHandle: null },
  },
  {
    url: "https://x.com/i/status/1234567890123456789",
    locator: { platform: "X", tweetId: "1234567890123456789", authorHandle: null },
  },
  {
    url: "https://astralcodexten.substack.com/p/example-post",
    locator: {
      platform: "SUBSTACK",
      origin: "https://astralcodexten.substack.com",
      slug: "example-post",
    },
  },
  {
    url: "https://en.wikipedia.org/wiki/C%2B%2B",
    locator: { platform: "WIKIPEDIA", article: { kind: "TITLE", language: "en", title: "C++" } },
  },
  {
    url: "https://en.wikipedia.org/w/index.php?curid=12345&oldid=1244905470",
    locator: {
      platform: "WIKIPEDIA",
      article: { kind: "PAGE_ID", language: "en", pageId: "12345", title: null },
    },
  },
];

const unsupportedUrls = [
  "https://www.lesswrong.com/",
  "https://www.lesswrong.com/posts",
  "https://x.com/home",
  "https://x.com/compose/post",
  "https://en.wikipedia.org/wiki/Talk:Climate_change",
  "https://en.wikipedia.org/w/index.php?oldid=1244905470",
  "https://example.com/i/status/1234567890123456789",
  "https://substack.com/p/example-post",
];

test("URL locators and URL-first adapter selection agree on supported post pages", () => {
  withDom("<main></main>", (document) => {
    for (const { url, locator } of supportedCases) {
      assert.deepEqual(knownHostPageLocator(url), locator, url);
      assert.deepEqual(pageLocatorFor(locator.platform, url), locator, url);
      assert.equal(selectAdapter(url, document)?.adapter.platformKey, locator.platform, url);
    }
  });
});

test("non-post URLs have no locator and select no adapter", () => {
  withDom("<main></main>", (document) => {
    for (const url of unsupportedUrls) {
      assert.equal(knownHostPageLocator(url), null, url);
      assert.equal(selectAdapter(url, document), null, url);
    }
  });
});

test("custom-domain Substack pages are recognized only with the Substack DOM fingerprint", () => {
  const url = "https://www.astralcodexten.com/p/example-post";
  assert.equal(knownHostPageLocator(url), null);
  assert.equal(isPossibleCustomDomainSubstackPage(url), true);
  withDom(
    "<main></main>",
    (document) => {
      assert.equal(selectAdapter(url, document), null);
    },
    url,
  );
  withDom(
    '<head><link rel="stylesheet" href="https://substackcdn.com/bundle.css"></head><main></main>',
    (document) => {
      assert.deepEqual(selectAdapter(url, document)?.locator, {
        platform: "SUBSTACK",
        origin: "https://www.astralcodexten.com",
        slug: "example-post",
      });
    },
    url,
  );
});

test("Wikipedia pages match by page ID or title; other platforms by locator key", () => {
  const byTitle = pageLocatorFor("WIKIPEDIA", "https://en.wikipedia.org/wiki/Climate_change");
  const byTitleAndId = pageLocatorFor(
    "WIKIPEDIA",
    "https://en.wikipedia.org/wiki/Climate_change?curid=5042951",
  );
  const otherTitle = pageLocatorFor("WIKIPEDIA", "https://en.wikipedia.org/wiki/Global_warming");
  const otherLanguage = pageLocatorFor("WIKIPEDIA", "https://de.wikipedia.org/wiki/Climate_change");
  if (byTitle === null || byTitleAndId === null || otherTitle === null || otherLanguage === null) {
    throw new Error("expected Wikipedia locators");
  }
  assert.equal(isSamePage(byTitle, byTitleAndId), true);
  assert.equal(isSamePage(byTitle, otherTitle), false);
  assert.equal(isSamePage(byTitle, otherLanguage), false);

  const lwSlugA = pageLocatorFor("LESSWRONG", "https://www.lesswrong.com/posts/abc/one");
  const lwSlugB = pageLocatorFor("LESSWRONG", "https://www.lesswrong.com/posts/abc");
  if (lwSlugA === null || lwSlugB === null) throw new Error("expected LessWrong locators");
  assert.equal(pageLocatorKey(lwSlugA), pageLocatorKey(lwSlugB));
  assert.equal(isSamePage(lwSlugA, lwSlugB), true);
});
