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

// ── Parsoid heading wrapper format ────────────────────────────────────────────
// Wikipedia's Parsoid renderer wraps headings in <div class="mw-heading mw-headingN">,
// requiring special handling in both section removal and stop-condition detection.

test("Wikipedia adapter excludes section content under Parsoid div.mw-heading wrapper", () => {
  const result = withMwConfig(
    "https://en.wikipedia.org/wiki/Climate_change",
    `<!doctype html>
      <html>
        <body>
          <h1 id="firstHeading">Climate change</h1>
          <div id="mw-content-text">
            <div class="mw-parser-output">
              <p>Lead statement.</p>
              <div class="mw-heading mw-heading2">
                <h2 id="Notes">Notes</h2>
                <span class="mw-editsection">[edit]</span>
              </div>
              <ul><li>Some related link.</li></ul>
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
  assert.equal(ready.content.contentText.includes("Some related link."), false);
  assert.equal(ready.content.contentText, "Lead statement.");
});

test("Wikipedia adapter stops excluding at the next Parsoid heading of same level", () => {
  const result = withMwConfig(
    "https://en.wikipedia.org/wiki/Climate_change",
    `<!doctype html>
      <html>
        <body>
          <h1 id="firstHeading">Climate change</h1>
          <div id="mw-content-text">
            <div class="mw-parser-output">
              <p>Lead statement.</p>
              <div class="mw-heading mw-heading2">
                <h2 id="Notes">Notes</h2>
                <span class="mw-editsection">[edit]</span>
              </div>
              <ul><li>Excluded link.</li></ul>
              <div class="mw-heading mw-heading2">
                <h2 id="Legacy">Legacy</h2>
                <span class="mw-editsection">[edit]</span>
              </div>
              <p>Legacy content.</p>
              <div class="mw-heading mw-heading2">
                <h2 id="References">References</h2>
                <span class="mw-editsection">[edit]</span>
              </div>
              <ol class="references"><li>Ref.</li></ol>
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
  assert.equal(ready.content.contentText.includes("Excluded link."), false);
  assert.equal(ready.content.contentText.includes("Legacy content."), true);
  assert.equal(ready.content.contentText.includes("Ref."), false);
});

test("Wikipedia adapter treats div.mw-heading as a section boundary only with a direct heading child", () => {
  const result = withMwConfig(
    "https://en.wikipedia.org/wiki/Climate_change",
    `<!doctype html>
      <html>
        <body>
          <h1 id="firstHeading">Climate change</h1>
          <div id="mw-content-text">
            <div class="mw-parser-output">
              <p>Lead paragraph.</p>
              <h2><span class="mw-headline">References</span></h2>
              <p>Excluded reference text.</p>
              <div class="mw-heading mw-heading2">
                <div><h2>Nested pseudo heading</h2></div>
              </div>
              <p>Still excluded.</p>
              <h2><span class="mw-headline">History</span></h2>
              <p>Kept paragraph.</p>
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
  assert.equal(ready.content.contentText, "Lead paragraph. History Kept paragraph.");
});

test("Wikipedia adapter preserves separators across adjacent block elements", () => {
  const result = withMwConfig(
    "https://en.wikipedia.org/wiki/Climate_change",
    `<!doctype html>
      <html>
        <body>
          <h1 id="firstHeading">Climate change</h1>
          <div id="mw-content-text">
            <div class="mw-parser-output">
              <p>Alpha</p><p>Beta</p><div>Gamma</div>
              <table>
                <tbody>
                  <tr><th>Delta</th><td>Epsilon</td></tr>
                </tbody>
              </table>
              <p>Zeta</p>
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
  assert.equal(ready.content.contentText, "Alpha Beta Gamma Delta Epsilon Zeta");
});

test("Wikipedia adapter keeps infobox-style table text separated from surrounding prose", () => {
  const result = withMwConfig(
    "https://en.wikipedia.org/wiki/Assassination_of_Ali_Khamenei",
    `<!doctype html>
      <html>
        <body>
          <h1 id="firstHeading">Assassination of Ali Khamenei</h1>
          <div id="mw-content-text">
            <div class="mw-parser-output">
              <p>(Learn how and when to remove this message)</p>
              <table class="infobox">
                <tbody>
                  <tr><th>Assassination of Ali Khamenei</th></tr>
                  <tr><td>Part of the 2026 strikes on Iran</td></tr>
                </tbody>
              </table>
              <p>Article body starts here.</p>
            </div>
          </div>
        </body>
      </html>`,
    {
      wgNamespaceNumber: 0,
      wgArticleId: 82537558,
      wgRevisionId: 1341062788,
      wgContentLanguage: "en",
    },
    (document) => wikipediaAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(
    ready.content.contentText,
    "(Learn how and when to remove this message) Assassination of Ali Khamenei Part of the 2026 strikes on Iran Article body starts here.",
  );
});

// ── noscript exclusion ────────────────────────────────────────────────────────
// Wikipedia places a <noscript> CentralAutoLogin tracking pixel inside
// #mw-content-text, after .mw-parser-output closes. getContentRoot() returns
// #mw-content-text (not .mw-parser-output) because querySelector returns the
// first match in document order, and parent elements precede their descendants.
// So the noscript is always inside the extraction root.
//
// shouldExcludeWikipediaElement must exclude noscript to prevent two failure
// modes depending on the scripting environment:
//
//   Browser (scripting enabled): <noscript> content is a raw TEXT NODE with
//   literal HTML. The TreeWalker (SHOW_TEXT) visits it, adding the literal
//   <img…> markup to contentText. This causes canonicalization drift against the
//   Wikipedia Parse API, which does not include the noscript at all.
//
//   JSDOM (scripting disabled, as used in tests): <noscript> content is
//   HTML-parsed into element nodes. querySelectorAll("img[src]") finds the
//   <img> and adds the CentralAutoLogin URL to imageUrls/imageOccurrences,
//   causing mediaState to be "has_images" instead of "text_only".
//
// The Assassination_of_Ali_Khamenei page ends with "See also" (not excluded),
// so skipSectionLevel is NOT set — making the noscript visible to extraction
// even without the fix. This is the failure mode that was reported.

test("Wikipedia adapter excludes noscript tracking pixel when last section is not an excluded title", () => {
  // Mirrors the Assassination_of_Ali_Khamenei structure.
  const result = withMwConfig(
    "https://en.wikipedia.org/wiki/Assassination_of_Ali_Khamenei",
    `<!doctype html>
      <html>
        <body>
          <h1 id="firstHeading">Assassination of Ali Khamenei</h1>
          <div id="mw-content-text">
            <div class="mw-parser-output">
              <p>Article body text.</p>
              <div class="mw-heading mw-heading2"><h2>See also</h2></div>
              <ul><li>Related article</li></ul>
            </div>
            <noscript><img src="https://en.wikipedia.org/wiki/Special:CentralAutoLogin/start?useformat=desktop&amp;type=1x1&amp;usesul3=1" alt="" width="1" height="1" style="border: none; position: absolute;"></noscript>
            <div class="printfooter">Retrieved from &quot;...&quot;</div>
          </div>
        </body>
      </html>`,
    {
      wgNamespaceNumber: 0,
      wgArticleId: 82537558,
      wgRevisionId: 1341069315,
      wgContentLanguage: "en",
    },
    (document) => wikipediaAdapter.extract(document),
  );

  const ready = assertReady(result);
  // Article body and See also content must be included (See also is not excluded).
  assert.ok(
    ready.content.contentText.includes("Article body text."),
    "article body text must be included",
  );
  assert.ok(
    ready.content.contentText.includes("Related article"),
    "See also section content must be included",
  );
  // CentralAutoLogin tracking pixel must not appear in content or image metadata.
  assert.ok(
    !ready.content.contentText.includes("CentralAutoLogin"),
    "noscript tracking pixel must not appear in contentText",
  );
  assert.ok(
    !ready.content.contentText.includes("<img"),
    "no literal HTML tags should appear in contentText",
  );
  // In JSDOM (scripting disabled), <noscript> content is parsed as elements,
  // so the img would be found by querySelectorAll unless noscript is pruned first.
  assert.equal(
    ready.content.mediaState,
    "text_only",
    "noscript img must not be classified as article image",
  );
  assert.ok(
    ready.content.imageUrls.every((url) => !url.includes("CentralAutoLogin")),
    "CentralAutoLogin URL must not appear in imageUrls",
  );
});
