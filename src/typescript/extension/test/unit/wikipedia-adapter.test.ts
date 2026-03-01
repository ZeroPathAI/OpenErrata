import assert from "node:assert/strict";
import { test } from "node:test";
import type { JSDOM } from "jsdom";
import { wikipediaAdapter } from "../../src/content/adapters/wikipedia.js";
import { assertNotReady, assertReady, withWindow } from "../helpers/adapter-harness.js";

function withMwConfig<T>(
  url: string,
  html: string,
  mwConfig: Record<string, unknown>,
  run: (document: Document) => T,
): T {
  return withWindow(url, html, run, {
    globalSetup(domWindow: JSDOM["window"]) {
      Object.defineProperty(domWindow, "mw", {
        value: {
          config: {
            get(key: string) {
              return mwConfig[key];
            },
          },
        },
        configurable: true,
      });
    },
  });
}

function withInlineConfigScript<T>(
  url: string,
  htmlBody: string,
  run: (document: Document) => T,
): T {
  return withWindow(
    url,
    `<!doctype html>
      <html>
        <head>
          <script>
            RLCONF={"wgNamespaceNumber":0,"wgPageName":"Climate_change","wgArticleId":12345,"wgRevisionId":67890,"wgRevisionTimestamp":"20260115010203"};
          </script>
        </head>
        <body>
          ${htmlBody}
        </body>
      </html>`,
    run,
  );
}

test("Wikipedia adapter extracts article content and excludes references section text", () => {
  const result = withMwConfig(
    "https://en.wikipedia.org/wiki/Climate_change",
    `<!doctype html>
      <html>
        <body>
          <h1 id="firstHeading">Climate change</h1>
          <div id="mw-content-text">
            <div class="mw-parser-output">
              <p>Human activity is warming the planet.</p>
              <h2><span class="mw-headline">Evidence</span></h2>
              <p>Global temperatures are rising.</p>
              <figure>
                <img src="/images/example.jpg" />
                <figcaption>Observed warming trend.</figcaption>
              </figure>
              <h2><span class="mw-headline">References</span></h2>
              <ol class="references">
                <li>Reference that should be excluded.</li>
              </ol>
            </div>
          </div>
        </body>
      </html>`,
    {
      wgNamespaceNumber: 0,
      wgArticleId: 12345,
      wgRevisionId: 67890,
      wgRevisionTimestamp: "20260115010203",
      wgContentLanguage: "en",
    },
    (document) => wikipediaAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(ready.content.platform, "WIKIPEDIA");
  assert.equal(ready.content.externalId, "en:12345");
  assert.equal(ready.content.mediaState, "has_images");
  assert.deepEqual(ready.content.imageUrls, ["https://en.wikipedia.org/images/example.jpg"]);
  const imageOccurrences = ready.content.imageOccurrences;
  assert.notEqual(imageOccurrences, undefined);
  if (imageOccurrences === undefined) throw new Error("expected imageOccurrences");
  assert.equal(imageOccurrences.length, 1);
  const firstOccurrence = imageOccurrences[0];
  assert.ok(firstOccurrence);
  assert.equal(firstOccurrence.originalIndex, 0);
  assert.equal(firstOccurrence.sourceUrl, "https://en.wikipedia.org/images/example.jpg");
  assert.equal(firstOccurrence.captionText, "Observed warming trend.");
  assert.ok(firstOccurrence.normalizedTextOffset > 0);
  assert.equal(ready.content.metadata.pageId, "12345");
  assert.equal(ready.content.metadata.revisionId, "67890");
  assert.equal(ready.content.metadata.title, "Climate_change");
  assert.equal(ready.content.metadata.displayTitle, "Climate change");
  assert.equal(ready.content.metadata.lastModifiedAt, "2026-01-15T01:02:03.000Z");
  assert.equal(ready.content.contentText.includes("Observed warming trend."), true);
  assert.equal(ready.content.contentText.includes("Reference that should be excluded."), false);
});

test("Wikipedia adapter extracts content when metadata is only available through inline RLCONF", () => {
  const result = withInlineConfigScript(
    "https://en.wikipedia.org/wiki/Climate_change",
    `<h1 id="firstHeading">Climate change</h1>
     <div id="mw-content-text">
       <div class="mw-parser-output">
         <p>Human activity is warming the planet.</p>
       </div>
     </div>`,
    (document) => wikipediaAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(ready.content.platform, "WIKIPEDIA");
  assert.equal(ready.content.externalId, "en:12345");
  assert.equal(ready.content.metadata.pageId, "12345");
  assert.equal(ready.content.metadata.revisionId, "67890");
  assert.equal(ready.content.metadata.title, "Climate_change");
  assert.equal(ready.content.metadata.lastModifiedAt, "2026-01-15T01:02:03.000Z");
});

test("Wikipedia adapter supports /w/index.php title permalinks", () => {
  const result = withMwConfig(
    "https://en.wikipedia.org/w/index.php?title=Climate_change&oldid=1244905470",
    `<!doctype html>
      <html>
        <body>
          <h1 id="firstHeading">Climate change</h1>
          <div id="mw-content-text">
            <div class="mw-parser-output">
              <p>Human activity is warming the planet.</p>
            </div>
          </div>
        </body>
      </html>`,
    {
      wgNamespaceNumber: 0,
      wgArticleId: 12345,
      wgRevisionId: 1244905470,
      wgRevisionTimestamp: "20260115010203",
      wgContentLanguage: "en",
    },
    (document) => wikipediaAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(ready.content.externalId, "en:12345");
});

test("Wikipedia adapter derives metadata title from inline RLCONF on curid permalinks", () => {
  const result = withInlineConfigScript(
    "https://en.wikipedia.org/w/index.php?curid=12345&oldid=67890",
    `<h1 id="firstHeading">Climate change</h1>
     <div id="mw-content-text">
       <div class="mw-parser-output">
         <p>Human activity is warming the planet.</p>
       </div>
     </div>`,
    (document) => wikipediaAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(ready.content.platform, "WIKIPEDIA");
  assert.equal(ready.content.externalId, "en:12345");
  assert.equal(ready.content.metadata.title, "Climate_change");
});

test("Wikipedia adapter returns unsupported for non-main namespaces", () => {
  const result = withMwConfig(
    "https://en.wikipedia.org/wiki/Climate_change",
    `<!doctype html><html><body><div id="mw-content-text"><div class="mw-parser-output"><p>Text</p></div></div></body></html>`,
    {
      wgNamespaceNumber: 1,
      wgArticleId: 12345,
      wgRevisionId: 67890,
      wgContentLanguage: "en",
    },
    (document) => wikipediaAdapter.extract(document),
  );

  assertNotReady(result, "unsupported");
});

test("Wikipedia adapter returns missing_identity when revision metadata is unavailable", () => {
  const result = withMwConfig(
    "https://en.wikipedia.org/wiki/Climate_change",
    `<!doctype html><html><body><div id="mw-content-text"><div class="mw-parser-output"><p>Text</p></div></div></body></html>`,
    {
      wgNamespaceNumber: 0,
      wgArticleId: 12345,
      wgContentLanguage: "en",
    },
    (document) => wikipediaAdapter.extract(document),
  );

  assertNotReady(result, "missing_identity");
});

test("Wikipedia adapter excludes references-class blocks even without references heading", () => {
  const result = withMwConfig(
    "https://en.wikipedia.org/wiki/Climate_change",
    `<!doctype html>
      <html>
        <body>
          <h1 id="firstHeading">Climate change</h1>
          <div id="mw-content-text">
            <div class="mw-parser-output">
              <p>Lead statement.</p>
              <ol class="references">
                <li>Reference that should be excluded.</li>
              </ol>
              <p>Closing statement.</p>
            </div>
          </div>
        </body>
      </html>`,
    {
      wgNamespaceNumber: 0,
      wgArticleId: 12345,
      wgRevisionId: 67890,
      wgContentLanguage: "en",
    },
    (document) => wikipediaAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(ready.content.contentText.includes("Reference that should be excluded."), false);
  assert.equal(ready.content.contentText, "Lead statement. Closing statement.");
});
