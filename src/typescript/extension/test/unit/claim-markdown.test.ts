import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://openerrata.test/",
});
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSDOM global installation for test environment
const globalScope = globalThis as unknown as {
  window: Window & typeof globalThis;
  document: Document;
  Node: typeof Node;
};
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSDOM global installation for test environment
globalScope.window = dom.window as unknown as Window & typeof globalThis;
globalScope.document = dom.window.document;
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSDOM global installation for test environment
globalScope.Node = dom.window.Node as unknown as typeof Node;

const { renderClaimReasoningHtml } = await import("../../src/content/claim-markdown.js");

function renderToTemplate(markdown: string): HTMLTemplateElement {
  const template = document.createElement("template");
  template.innerHTML = renderClaimReasoningHtml(markdown);
  return template;
}

test("renderClaimReasoningHtml keeps valid markdown links with safe attributes", () => {
  const template = renderToTemplate("See [OpenErrata](https://example.com/docs?q=1).");
  const links = template.content.querySelectorAll("a");
  const firstLink = links.item(0);

  assert.equal(links.length, 1);
  assert.notEqual(firstLink, null);
  assert.equal(firstLink.textContent, "OpenErrata");
  assert.equal(firstLink.getAttribute("href"), "https://example.com/docs?q=1");
  assert.equal(firstLink.getAttribute("target"), "_blank");
  assert.equal(firstLink.getAttribute("rel"), "noopener noreferrer");
});

test("renderClaimReasoningHtml drops non-http(s) markdown links", () => {
  const template = renderToTemplate(
    "Bad [js](javascript:alert(1)) and [mailto](mailto:test@example.com).",
  );

  assert.equal(template.content.querySelectorAll("a").length, 0);
  assert.match(template.content.textContent, /Bad \[js\]\(javascript:alert\(1\)\) and mailto\./);
});
