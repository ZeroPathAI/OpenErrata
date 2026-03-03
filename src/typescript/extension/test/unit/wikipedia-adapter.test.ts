import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
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

// ── Stateless extraction across SPA navigations ──────────────────────────
// Wikipedia uses pushState for internal navigation, keeping the same Document
// object. The adapter must be stateless (no module-level cache) so that each
// extract() call reads the current inline scripts, not stale values from a
// previous article.

function makeWikipediaHtml(config: {
  wgArticleId: number;
  wgRevisionId: number;
  wgPageName: string;
}): string {
  return `<!doctype html>
    <html>
      <head>
        <script>
          RLCONF={"wgNamespaceNumber":0,"wgPageName":"${config.wgPageName}","wgArticleId":${config.wgArticleId.toString()},"wgRevisionId":${config.wgRevisionId.toString()},"wgRevisionTimestamp":"20260115010203"};
        </script>
      </head>
      <body>
        <h1 id="firstHeading">${config.wgPageName.replace(/_/g, " ")}</h1>
        <div id="mw-content-text">
          <div class="mw-parser-output">
            <p>Article content for ${config.wgPageName}.</p>
          </div>
        </div>
      </body>
    </html>`;
}

// ── Client HTML for fallback ──────────────────────────────────────────────────
// The Wikipedia adapter serializes the pruned DOM innerHTML into metadata.htmlContent
// so the server can use it as a CLIENT_HTML fallback when the Parse API is unavailable.

test("Wikipedia adapter includes htmlContent from pruned DOM in metadata", () => {
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
  const { htmlContent } = ready.content.metadata;
  assert.notEqual(htmlContent, undefined, "htmlContent should be present");
  assert.ok(
    typeof htmlContent === "string" && htmlContent.length > 0,
    "htmlContent should be non-empty",
  );
  // The HTML should come from the pruned clone — references section should be removed
  assert.ok(
    !htmlContent.includes("Reference that should be excluded."),
    "pruned HTML should exclude references section",
  );
  assert.ok(
    htmlContent.includes("Human activity is warming the planet."),
    "pruned HTML should include article content",
  );
});

test("Wikipedia adapter omits htmlContent when serialized HTML exceeds byte limit", () => {
  // Generate content that exceeds 256 KB when serialized.
  const largeParagraph = `<p>${"A".repeat(300_000)}</p>`;
  const result = withMwConfig(
    "https://en.wikipedia.org/wiki/Large_article",
    `<!doctype html>
      <html>
        <body>
          <h1 id="firstHeading">Large article</h1>
          <div id="mw-content-text">
            <div class="mw-parser-output">
              ${largeParagraph}
            </div>
          </div>
        </body>
      </html>`,
    {
      wgNamespaceNumber: 0,
      wgArticleId: 99999,
      wgRevisionId: 11111,
      wgRevisionTimestamp: "20260115010203",
      wgContentLanguage: "en",
    },
    (document) => wikipediaAdapter.extract(document),
  );

  const ready = assertReady(result);
  assert.equal(ready.content.platform, "WIKIPEDIA");
  assert.equal(
    ready.content.metadata.htmlContent,
    undefined,
    "htmlContent should be omitted when HTML exceeds 256 KB",
  );
});

test("Wikipedia adapter reads fresh config on each extract() call (stateless across SPA navigations)", () => {
  // Use JSDOM directly so we can mutate the same Document's URL via
  // dom.reconfigure() to simulate pushState navigation.
  const articleAUrl = "https://en.wikipedia.org/wiki/Climate_change";
  const articleBUrl = "https://en.wikipedia.org/wiki/Ocean_acidification";

  const dom = new JSDOM(
    makeWikipediaHtml({ wgArticleId: 12345, wgRevisionId: 11111, wgPageName: "Climate_change" }),
    { url: articleAUrl },
  );

  const scope = globalThis as Record<string, unknown>;
  const savedWindow = scope["window"];
  const savedDocument = scope["document"];
  const savedDocumentCtor = scope["Document"];
  const savedElementCtor = scope["Element"];
  const savedNodeCtor = scope["Node"];
  const savedNodeFilterCtor = scope["NodeFilter"];

  scope["window"] = dom.window;
  scope["document"] = dom.window.document;
  scope["Document"] = dom.window.Document;
  scope["Element"] = dom.window.Element;
  scope["Node"] = dom.window.Node;
  scope["NodeFilter"] = dom.window.NodeFilter;

  try {
    // Extract article A — should read pageId 12345
    const resultA = wikipediaAdapter.extract(dom.window.document);
    const readyA = assertReady(resultA);
    assert.equal(readyA.content.platform, "WIKIPEDIA");
    assert.equal(readyA.content.metadata.pageId, "12345");

    // Simulate SPA navigation: change URL and replace inline script content
    dom.reconfigure({ url: articleBUrl });
    const script = dom.window.document.querySelector("script:not([src])");
    assert.ok(script, "inline script must exist");
    script.textContent = `RLCONF={"wgNamespaceNumber":0,"wgPageName":"Ocean_acidification","wgArticleId":67890,"wgRevisionId":22222,"wgRevisionTimestamp":"20260215010203"};`;

    // Also update the heading and body for adapter identity extraction
    const heading = dom.window.document.querySelector("#firstHeading");
    if (heading) heading.textContent = "Ocean acidification";
    const paragraph = dom.window.document.querySelector(".mw-parser-output p");
    if (paragraph) paragraph.textContent = "Article content for Ocean_acidification.";

    // Extract article B — must read pageId 67890, NOT stale 12345
    const resultB = wikipediaAdapter.extract(dom.window.document);
    const readyB = assertReady(resultB);
    assert.equal(readyB.content.platform, "WIKIPEDIA");
    assert.equal(
      readyB.content.metadata.pageId,
      "67890",
      "each extract() call must read current inline scripts, not stale values",
    );
    assert.equal(readyB.content.metadata.title, "Ocean_acidification");
  } finally {
    scope["window"] = savedWindow;
    scope["document"] = savedDocument;
    scope["Document"] = savedDocumentCtor;
    scope["Element"] = savedElementCtor;
    scope["Node"] = savedNodeCtor;
    scope["NodeFilter"] = savedNodeFilterCtor;
  }
});
