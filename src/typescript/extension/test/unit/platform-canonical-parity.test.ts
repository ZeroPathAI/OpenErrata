import assert from "node:assert/strict";
import { test } from "node:test";
import type { JSDOM } from "jsdom";
import {
  lesswrongHtmlToNormalizedText,
  wikipediaHtmlToNormalizedText,
} from "../../../api/src/lib/services/content-fetcher.js";
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
// Loads the captured Wikipedia Parsoid HTML fixture to verify that client-side
// extraction (DOM TreeWalker) and server-side canonicalization (parse5) produce
// identical normalized text.  This test would have caught both the Parsoid
// heading-wrapper bug and the compact-HTML block-separator gap before they
// reached production.
//
// The Wikipedia adapter's mw.config reads fall back to parsing inline
// <script> tags when window.mw is not set (as in JSDOM), so no mw global
// setup is required here.

test("WIKIPEDIA client extraction matches API canonical text normalization on a real Parsoid fixture page", async () => {
  const fixture = await readE2eWikipediaFixture(E2E_WIKIPEDIA_FIXTURE_KEYS.ALI_KHAMENEI_PAGE_HTML);

  const { ready, contentRoot } = withWindow(fixture.sourceUrl, fixture.html, (document) => ({
    ready: assertReady(wikipediaAdapter.extract(document)),
    contentRoot: wikipediaAdapter.getContentRoot(document),
  }));

  if (!contentRoot) {
    throw new Error("Expected wikipedia content root for fixture canonical parity test");
  }

  const clientText = ready.content.contentText;
  const serverText = wikipediaHtmlToNormalizedText(contentRoot.outerHTML);
  assert.equal(clientText, serverText);
});
