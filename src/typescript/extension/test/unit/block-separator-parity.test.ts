import assert from "node:assert/strict";
import { test } from "node:test";
import { WORD_SEPARATOR_TAGS } from "@openerrata/shared";
import {
  lesswrongHtmlToNormalizedText,
  wikipediaHtmlToNormalizedText,
} from "../../../api/src/lib/services/content-fetcher.js";
import { extractContent } from "../../src/content/adapters/utils.js";
import { withWindow } from "../helpers/adapter-harness.js";

// ── Client/Server word separator parity ─────────────────────────────────
// For every tag in WORD_SEPARATOR_TAGS, synthetic HTML containing
// adjacent elements of that tag must produce identical normalized text from
// client-side JSDOM TreeWalker extraction and server-side parse5 extraction.
// This catches bugs where one side injects a word-boundary separator and the
// other does not (the single most common parity bug class).

/**
 * Table-related tags can't contain text as direct children in valid HTML.
 * parse5 foster-parents bare text outside the element, defeating the test.
 * Void elements (<br>, <hr>) hold no text and separate the text around them.
 * These overrides provide minimal valid structures that exercise each such
 * tag as a separator. (Duplicated from content-fetcher.test.ts by design —
 * the parity test must use the same HTML through both engines.)
 */
const SEPARATOR_HTML_OVERRIDES: Record<string, string> = {
  tr: "<table><tbody><tr><td>Word1</td></tr><tr><td>Word2</td></tr></tbody></table>",
  td: "<table><tbody><tr><td>Word1</td><td>Word2</td></tr></tbody></table>",
  th: "<table><thead><tr><th>Word1</th><th>Word2</th></tr></thead></table>",
  br: "<p>Word1<br>Word2</p>",
  hr: "Word1<hr>Word2",
};

function extractClientText(html: string, url: string): string {
  return withWindow(url, `<!doctype html><html><body>${html}</body></html>`, (document) => {
    const root = document.body;
    return extractContent(root, { exclude: () => false, imageSelector: "img[src]", baseUrl: url })
      .contentText;
  });
}

test("client JSDOM and server parse5 produce identical normalized text for every CONTENT_BLOCK_SEPARATOR_TAG (LessWrong path)", () => {
  for (const tag of WORD_SEPARATOR_TAGS) {
    const html = SEPARATOR_HTML_OVERRIDES[tag] ?? `<${tag}>Word1</${tag}><${tag}>Word2</${tag}>`;
    const clientText = extractClientText(html, "https://www.lesswrong.com/posts/test/parity");
    const serverText = lesswrongHtmlToNormalizedText(html);

    assert.equal(
      clientText,
      serverText,
      `Word separator parity failed for <${tag}> (LessWrong):\n` +
        `  client: ${JSON.stringify(clientText)}\n` +
        `  server: ${JSON.stringify(serverText)}`,
    );
  }
});

test("client JSDOM and server parse5 produce identical normalized text for every CONTENT_BLOCK_SEPARATOR_TAG (Wikipedia path)", () => {
  for (const tag of WORD_SEPARATOR_TAGS) {
    const inner = SEPARATOR_HTML_OVERRIDES[tag] ?? `<${tag}>Word1</${tag}><${tag}>Word2</${tag}>`;
    const wikiHtml = `<div class="mw-parser-output">${inner}</div>`;

    const clientText = withWindow(
      "https://en.wikipedia.org/wiki/Test",
      `<!doctype html><html><body><div id="mw-content-text">${wikiHtml}</div></body></html>`,
      (document) => {
        const root = document.querySelector(".mw-parser-output");
        if (!root) throw new Error("Missing .mw-parser-output");
        return extractContent(root, {
          exclude: () => false,
          imageSelector: "img[src]",
          baseUrl: "https://en.wikipedia.org/wiki/Test",
        }).contentText;
      },
    );
    const serverText = wikipediaHtmlToNormalizedText(wikiHtml);

    assert.equal(
      clientText,
      serverText,
      `Word separator parity failed for <${tag}> (Wikipedia):\n` +
        `  client: ${JSON.stringify(clientText)}\n` +
        `  server: ${JSON.stringify(serverText)}`,
    );
  }
});
