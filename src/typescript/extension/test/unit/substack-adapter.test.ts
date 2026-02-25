import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { substackAdapter } from "../../src/content/adapters/substack.js";
import type { AdapterExtractionResult } from "../../src/content/adapters/model.js";

type GlobalWindowScope = typeof globalThis & {
  window?: Window & typeof globalThis;
};

function withWindow<T>(url: string, html: string, run: (document: Document) => T): T {
  const dom = new JSDOM(html, { url });
  const scope = globalThis as GlobalWindowScope;
  const previousWindow = scope.window;
  scope.window = dom.window as unknown as Window & typeof globalThis;
  try {
    return run(dom.window.document);
  } finally {
    if (previousWindow === undefined) {
      delete scope.window;
    } else {
      scope.window = previousWindow;
    }
  }
}

function assertReady(
  result: AdapterExtractionResult,
): Extract<AdapterExtractionResult, { kind: "ready" }> {
  assert.equal(result.kind, "ready");
  return result;
}

function assertNotReady(
  result: AdapterExtractionResult,
  reason: Extract<AdapterExtractionResult, { kind: "not_ready" }>["reason"],
): Extract<AdapterExtractionResult, { kind: "not_ready" }> {
  assert.equal(result.kind, "not_ready");
  assert.equal(result.reason, reason);
  return result;
}

test("Substack adapter returns missing_identity when slug is absent", () => {
  const result = withWindow(
    "https://example.substack.com/",
    "<!doctype html><html><body></body></html>",
    (document) => substackAdapter.extract(document),
  );

  assertNotReady(result, "missing_identity");
});

test("Substack adapter returns hydrating when content root is missing", () => {
  const result = withWindow(
    "https://example.substack.com/p/test-post",
    `
      <!doctype html>
      <html>
        <head>
          <meta name="author" content="Example Author" />
        </head>
        <body>
          <h1 class="post-title">Test Post</h1>
        </body>
      </html>
    `,
    (document) => substackAdapter.extract(document),
  );

  assertNotReady(result, "hydrating");
});

test("Substack adapter returns missing_identity when post id cannot be proven", () => {
  const result = withWindow(
    "https://example.substack.com/p/test-post",
    `
      <!doctype html>
      <html>
        <head>
          <meta name="author" content="Example Author" />
        </head>
        <body>
          <h1 class="post-title">Test Post</h1>
          <div class="body markup">Post body text.</div>
        </body>
      </html>
    `,
    (document) => substackAdapter.extract(document),
  );

  assertNotReady(result, "missing_identity");
});

test("Substack adapter returns missing_identity when publication subdomain is unknown", () => {
  const result = withWindow(
    "https://newsletter.example.com/p/test-post",
    `
      <!doctype html>
      <html>
        <head>
          <meta name="author" content="Example Author" />
          <meta name="twitter:image" content="https://cdn.example.com/post_preview/123456/twitter.jpg" />
        </head>
        <body>
          <h1 class="post-title">Test Post</h1>
          <div class="body markup">Post body text.</div>
        </body>
      </html>
    `,
    (document) => substackAdapter.extract(document),
  );

  assertNotReady(result, "missing_identity");
});

test("Substack adapter returns ready when identity metadata is complete", () => {
  const postId = "123456";
  const result = withWindow(
    "https://example.substack.com/p/test-post",
    `
      <!doctype html>
      <html>
        <head>
          <meta name="author" content="Example Author" />
          <meta
            name="twitter:image"
            content="https://substackcdn.com/image/fetch/w_1456,c_limit,f_jpg,q_auto:good,fl_progressive:steep/https%3A%2F%2Fexample.substack.com%2Fpost_preview%2F${postId}%2Ftwitter.jpg"
          />
        </head>
        <body>
          <h1 class="post-title">Test Post</h1>
          <div class="body markup">Post body text.</div>
        </body>
      </html>
    `,
    (document) => substackAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(ready.content.platform, "SUBSTACK");
  assert.equal(ready.content.externalId, postId);
  assert.equal(ready.content.metadata.slug, "test-post");
  assert.equal(ready.content.metadata.publicationSubdomain, "example");
});
