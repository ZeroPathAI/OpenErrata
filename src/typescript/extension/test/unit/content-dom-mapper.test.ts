import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { InvestigationClaim } from "@openerrata/shared";
import { mapClaimsToDom } from "../../src/content/dom-mapper.js";

function installDom(html: string): () => void {
  const dom = new JSDOM(html, { url: "https://example.com" });
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNode = globalThis.Node;
  const originalText = globalThis.Text;
  const originalElement = globalThis.Element;
  const originalNodeFilter = globalThis.NodeFilter;
  const originalRange = globalThis.Range;

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    Text: dom.window.Text,
    Element: dom.window.Element,
    NodeFilter: dom.window.NodeFilter,
    Range: dom.window.Range,
  });

  return () => {
    dom.window.close();
    Object.assign(globalThis, {
      window: originalWindow,
      document: originalDocument,
      Node: originalNode,
      Text: originalText,
      Element: originalElement,
      NodeFilter: originalNodeFilter,
      Range: originalRange,
    });
  };
}

function createClaim(text: string, context: string): InvestigationClaim {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded type from plain value in test factory
    id: "claim-dom-1" as InvestigationClaim["id"],
    text,
    context,
    summary: "Claim summary",
    reasoning: "Claim reasoning",
    sources: [
      {
        url: "https://example.com/source",
        title: "Source",
        snippet: "Snippet",
      },
    ],
  };
}

test("mapClaimsToDom preserves UTF-16 offset alignment after astral emoji", () => {
  const restoreDom = installDom(
    "<!doctype html><html><body><article id='root'>Prefix 😀 target text suffix.</article></body></html>",
  );

  try {
    const root = document.getElementById("root");
    if (!(root instanceof Element)) {
      throw new Error("Missing #root test fixture");
    }

    const claimText = "target text";
    const [annotation] = mapClaimsToDom(
      [createClaim(claimText, "Prefix 😀 target text suffix.")],
      root,
    );
    if (annotation === undefined) {
      throw new Error("Expected one annotation result");
    }

    assert.equal(annotation.matched, true);
    assert.notEqual(annotation.range, null);
    assert.equal(annotation.range?.toString(), claimText);
  } finally {
    restoreDom();
  }
});
