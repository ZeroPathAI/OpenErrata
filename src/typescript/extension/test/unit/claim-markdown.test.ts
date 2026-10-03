import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://openerrata.test/",
});

const globalScope = globalThis as unknown as {
  window: Window & typeof globalThis;
  document: Document;
  Node: typeof Node;
};

globalScope.window = dom.window as unknown as Window & typeof globalThis;
globalScope.document = dom.window.document;

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

test("renderClaimReasoningHtml never emits images that would load attacker-chosen URLs", () => {
  const template = renderToTemplate(
    "Evidence: ![tracking pixel](https://attacker.example/pixel.png?reader=1) and <img src=https://attacker.example/raw.png>.",
  );

  assert.equal(template.content.querySelectorAll("img").length, 0);
  // Nothing loads by itself: no element references a URL except links, which need a click.
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    assert.equal(element.hasAttribute("src"), false);
    assert.equal(element.hasAttribute("srcset"), false);
  }
});

test("renderClaimReasoningHtml strips attributes and tags outside the formatting allowlist", () => {
  const template = renderToTemplate(
    "Some **bold** text and `code`.\n\n| a | b |\n|---|---|\n| 1 | 2 |",
  );

  assert.notEqual(template.content.querySelector("strong"), null);
  assert.notEqual(template.content.querySelector("code"), null);
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      assert.ok(
        ["href", "target", "rel"].includes(attribute.name),
        `unexpected attribute ${attribute.name} on <${element.tagName.toLowerCase()}>`,
      );
    }
  }
});
