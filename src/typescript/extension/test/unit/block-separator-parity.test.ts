import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTENT_BLOCK_SEPARATOR_TAGS } from "@openerrata/shared";
import {
  lesswrongHtmlToNormalizedText,
  wikipediaHtmlToNormalizedText,
} from "../../../api/src/lib/services/content-fetcher.js";
import { extractContentWithImageOccurrencesFromRoot } from "../../src/content/adapters/utils.js";
import { withWindow } from "../helpers/adapter-harness.js";

// ── Client/Server block separator parity ────────────────────────────────
// For every tag in CONTENT_BLOCK_SEPARATOR_TAGS, synthetic HTML containing
// adjacent elements of that tag must produce identical normalized text from
// client-side JSDOM TreeWalker extraction and server-side parse5 extraction.
// This catches bugs where one side injects a word-boundary separator and the
// other does not (the single most common parity bug class).

/**
 * Table-related tags can't contain text as direct children in valid HTML.
 * parse5 foster-parents bare text outside the element, defeating the test.
 * These overrides provide minimal valid table structures that exercise each
 * tag as a separator. (Duplicated from content-fetcher.test.ts by design —
 * the parity test must use the same HTML through both engines.)
 */
const TABLE_BLOCK_SEPARATOR_HTML: Record<string, string> = {
  tr: "<table><tbody><tr><td>Word1</td></tr><tr><td>Word2</td></tr></tbody></table>",
  td: "<table><tbody><tr><td>Word1</td><td>Word2</td></tr></tbody></table>",
  th: "<table><thead><tr><th>Word1</th><th>Word2</th></tr></thead></table>",
};

function extractClientText(html: string, url: string): string {
  return withWindow(url, `<!doctype html><html><body>${html}</body></html>`, (document) => {
    const root = document.body;
    return extractContentWithImageOccurrencesFromRoot(root, url).contentText;
  });
}

test("client JSDOM and server parse5 produce identical normalized text for every CONTENT_BLOCK_SEPARATOR_TAG (LessWrong path)", () => {
  for (const tag of CONTENT_BLOCK_SEPARATOR_TAGS) {
    const html = TABLE_BLOCK_SEPARATOR_HTML[tag] ?? `<${tag}>Word1</${tag}><${tag}>Word2</${tag}>`;
    const clientText = extractClientText(html, "https://www.lesswrong.com/posts/test/parity");
    const serverText = lesswrongHtmlToNormalizedText(html);

    assert.equal(
      clientText,
      serverText,
      `Block separator parity failed for <${tag}> (LessWrong):\n` +
        `  client: ${JSON.stringify(clientText)}\n` +
        `  server: ${JSON.stringify(serverText)}`,
    );
  }
});

test("client JSDOM and server parse5 produce identical normalized text for every CONTENT_BLOCK_SEPARATOR_TAG (Wikipedia path)", () => {
  for (const tag of CONTENT_BLOCK_SEPARATOR_TAGS) {
    const inner = TABLE_BLOCK_SEPARATOR_HTML[tag] ?? `<${tag}>Word1</${tag}><${tag}>Word2</${tag}>`;
    const wikiHtml = `<div class="mw-parser-output">${inner}</div>`;

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
      `Block separator parity failed for <${tag}> (Wikipedia):\n` +
        `  client: ${JSON.stringify(clientText)}\n` +
        `  server: ${JSON.stringify(serverText)}`,
    );
  }
});
