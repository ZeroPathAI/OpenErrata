import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { JSDOM } from "jsdom";
import {
  lesswrongHtmlToNormalizedText,
  wikipediaHtmlToNormalizedText,
} from "../../../api/src/lib/services/content-fetcher.js";
import { extractContentWithImageOccurrencesFromRoot } from "../../src/content/adapters/utils.js";
import { lesswrongAdapter } from "../../src/content/adapters/lesswrong.js";
import { wikipediaAdapter } from "../../src/content/adapters/wikipedia.js";
import { assertReady, withWindow } from "../helpers/adapter-harness.js";
import { E2E_WIKIPEDIA_FIXTURE_KEYS, readE2eWikipediaFixture } from "../e2e/wikipedia-fixtures.js";

function withWikipediaMwConfig<T>(
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

test("LESSWRONG client extraction matches API canonical text normalization", () => {
  const ready = assertReady(
    withWindow(
      "https://www.lesswrong.com/posts/abcd1234/parity-test",
      `
      <!doctype html>
      <html>
        <body>
          <div id="postBody">
            <script type="application/ld+json">
              {"url":"https://www.lesswrong.com/posts/abcd1234/parity-test"}
            </script>
            <div class="LWPostsPageHeader-authorInfo">
              <span class="PostsAuthors-authorName">
                <a href="/users/example_author">Example Author</a>
              </span>
            </div>
            <div class="PostsPage-postContent">
              <div id="postContent">
                <p>Alpha</p><p>Beta</p><div>Gamma</div>
              </div>
            </div>
          </div>
        </body>
      </html>
      `,
      (document) => lesswrongAdapter.extract(document),
    ),
  );

  if (ready.content.platform !== "LESSWRONG") {
    throw new Error("Expected LESSWRONG platform for parity test");
  }
  const clientText = ready.content.contentText;
  const serverText = lesswrongHtmlToNormalizedText(ready.content.metadata.htmlContent);
  assert.equal(clientText, serverText);
});

test("WIKIPEDIA client extraction matches API canonical text normalization", () => {
  const ready = assertReady(
    withWikipediaMwConfig(
      "https://en.wikipedia.org/wiki/Assassination_of_Ali_Khamenei",
      `
      <!doctype html>
      <html>
        <body>
          <h1 id="firstHeading">Assassination of Ali Khamenei</h1>
          <div id="mw-content-text">
            <div class="mw-parser-output">
              <p>Alpha</p><p>Beta</p><div>Gamma</div>
              <table class="infobox">
                <tbody>
                  <tr><th>Delta</th><td>Epsilon</td></tr>
                </tbody>
              </table>
              <p>Zeta</p>
            </div>
          </div>
        </body>
      </html>
      `,
      {
        wgNamespaceNumber: 0,
        wgArticleId: 82537558,
        wgRevisionId: 1341062788,
        wgRevisionTimestamp: "20260301010203",
        wgPageName: "Assassination_of_Ali_Khamenei",
      },
      (document) => wikipediaAdapter.extract(document),
    ),
  );

  const contentRoot = withWikipediaMwConfig(
    "https://en.wikipedia.org/wiki/Assassination_of_Ali_Khamenei",
    `
      <!doctype html>
      <html>
        <body>
          <h1 id="firstHeading">Assassination of Ali Khamenei</h1>
          <div id="mw-content-text">
            <div class="mw-parser-output">
              <p>Alpha</p><p>Beta</p><div>Gamma</div>
              <table class="infobox">
                <tbody>
                  <tr><th>Delta</th><td>Epsilon</td></tr>
                </tbody>
              </table>
              <p>Zeta</p>
            </div>
          </div>
        </body>
      </html>
      `,
    {
      wgNamespaceNumber: 0,
      wgArticleId: 82537558,
      wgRevisionId: 1341062788,
      wgRevisionTimestamp: "20260301010203",
      wgPageName: "Assassination_of_Ali_Khamenei",
    },
    (document) => wikipediaAdapter.getContentRoot(document),
  );

  if (!contentRoot) {
    throw new Error("Expected wikipedia content root for canonical parity test");
  }

  const clientText = ready.content.contentText;
  const serverText = wikipediaHtmlToNormalizedText(contentRoot.outerHTML);
  assert.equal(clientText, serverText);
});

// ── Real-page fixture parity ───────────────────────────────────────────────
// Loads the captured Wikipedia Parsoid HTML fixtures to verify that client-side
// extraction (DOM TreeWalker on the full page) and server-side canonicalization
// (parse5 on the Wikipedia Parse API response) produce identical normalized text.
//
// Crucially, the server-side input is the stored `parseApiHtml` — the actual
// Wikipedia Parse API output — NOT `contentRoot.outerHTML` from the same
// document. Using the same document for both sides would mask bugs like
// getContentRoot() returning the wrong DOM element: if both sides use
// `#mw-content-text` instead of `.mw-parser-output`, they agree but are both
// wrong. The Parse API only returns the article body (`.mw-parser-output`
// equivalent), so a mismatch in root selection produces a visible content
// difference that the test catches.
//
// The Wikipedia adapter's mw.config reads fall back to parsing inline
// <script> tags when window.mw is not set (as in JSDOM), so no mw global
// setup is required here.

for (const fixtureKey of Object.values(E2E_WIKIPEDIA_FIXTURE_KEYS)) {
  test(`WIKIPEDIA client extraction matches Parse API canonical text for ${fixtureKey}`, async () => {
    const fixture = await readE2eWikipediaFixture(fixtureKey);

    const ready = withWindow(fixture.sourceUrl, fixture.html, (document) =>
      assertReady(wikipediaAdapter.extract(document)),
    );

    const clientText = ready.content.contentText;
    const serverText = wikipediaHtmlToNormalizedText(fixture.parseApiHtml);
    assert.equal(clientText, serverText);
  });
}

// ── Synthetic structural parity ─────────────────────────────────────────
// Corner cases where client TreeWalker and server parse5 historically
// diverged. Each case exercises a specific structural pattern that can
// cause block-separator injection asymmetry. Tests run the same HTML
// through both JSDOM extraction (client) and parse5 (server) and assert
// identical normalized output.

function extractClientTextFromBody(html: string, url: string): string {
  return withWindow(url, `<!doctype html><html><body>${html}</body></html>`, (document) => {
    return extractContentWithImageOccurrencesFromRoot(document.body, url).contentText;
  });
}

const STRUCTURAL_PARITY_CASES: { name: string; html: string }[] = [
  {
    name: "block-inline boundary",
    html: "<div>about</div><span>inline</span>",
  },
  {
    name: "empty block element",
    html: "<p></p><p>text</p>",
  },
  {
    name: "nested blocks",
    html: "<p>a</p><div><p>b</p></div>",
  },
  {
    name: "table + paragraph",
    html: "<table><tr><td>x</td></tr></table><p>y</p>",
  },
  {
    name: "inline within block",
    html: "<p>word1<strong>word2</strong>word3</p>",
  },
];

describe("synthetic structural parity: client JSDOM vs server parse5", () => {
  for (const { name, html } of STRUCTURAL_PARITY_CASES) {
    test(`LessWrong path: ${name}`, () => {
      const clientText = extractClientTextFromBody(
        html,
        "https://www.lesswrong.com/posts/test/structural",
      );
      const serverText = lesswrongHtmlToNormalizedText(html);
      assert.equal(
        clientText,
        serverText,
        `Structural parity failed for "${name}":\n` +
          `  client: ${JSON.stringify(clientText)}\n` +
          `  server: ${JSON.stringify(serverText)}`,
      );
    });
  }

  for (const { name, html } of STRUCTURAL_PARITY_CASES) {
    test(`Wikipedia path: ${name}`, () => {
      const wikiHtml = `<div class="mw-parser-output">${html}</div>`;

      const clientText = withWindow(
        "https://en.wikipedia.org/wiki/Test",
        `<!doctype html><html><body><div id="mw-content-text">${wikiHtml}</div></body></html>`,
        (document) => {
          const root = document.querySelector(".mw-parser-output");
          if (!root) throw new Error("Missing .mw-parser-output");
          return extractContentWithImageOccurrencesFromRoot(
            root,
            "https://en.wikipedia.org/wiki/Test",
          ).contentText;
        },
      );
      const serverText = wikipediaHtmlToNormalizedText(wikiHtml);
      assert.equal(
        clientText,
        serverText,
        `Structural parity failed for "${name}" (Wikipedia):\n` +
          `  client: ${JSON.stringify(clientText)}\n` +
          `  server: ${JSON.stringify(serverText)}`,
      );
    });
  }
});
