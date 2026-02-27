import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { InvestigationClaim } from "@openerrata/shared";
import { AnnotationController } from "../../src/content/annotations";

function installDom(html: string): () => void {
  const dom = new JSDOM(html, { url: "https://example.com" });
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNode = globalThis.Node;
  const originalText = globalThis.Text;
  const originalElement = globalThis.Element;
  const originalNodeFilter = globalThis.NodeFilter;
  const originalMutationObserver = globalThis.MutationObserver;
  const originalRange = globalThis.Range;

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    Text: dom.window.Text,
    Element: dom.window.Element,
    NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver,
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
      MutationObserver: originalMutationObserver,
      Range: originalRange,
    });
  };
}

function createClaim(text: string): InvestigationClaim {
  return {
    id: "claim-1" as InvestigationClaim["id"],
    text,
    context: text,
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

test("AnnotationController manages visibility and claim state transitions", () => {
  const restoreDom = installDom(
    '<!doctype html><html><body><div id="root">This page has no annotations yet.</div></body></html>',
  );
  const controller = new AnnotationController();

  try {
    assert.equal(controller.isVisible(), true);
    assert.deepEqual(controller.getClaims(), []);

    const claim = createClaim("No-op claim");
    controller.setClaims([claim]);
    assert.deepEqual(controller.getClaims(), [claim]);

    controller.hide();
    assert.equal(controller.isVisible(), false);

    controller.show(null);
    assert.equal(controller.isVisible(), true);

    controller.clearAll();
    assert.deepEqual(controller.getClaims(), []);
  } finally {
    restoreDom();
  }
});

test("AnnotationController render + reapplyIfMissing map claims into the content root", () => {
  const restoreDom = installDom(
    '<!doctype html><html><body><article id="root">Earth is round and orbits the sun.</article></body></html>',
  );
  const controller = new AnnotationController();
  const claim = createClaim("Earth is round and orbits the sun.");
  const adapter = {
    getContentRoot: () => document.getElementById("root"),
  };

  try {
    controller.setClaims([claim]);
    assert.equal(controller.render(adapter as never), true);
    assert.equal(document.querySelectorAll(".openerrata-annotation").length > 0, true);

    // Force annotation disappearance and verify reapply path restores marks.
    const root = document.getElementById("root");
    if (!root) throw new Error("Missing #root test fixture");
    root.textContent = "Earth is round and orbits the sun.";
    assert.equal(document.querySelectorAll(".openerrata-annotation").length, 0);

    controller.reapplyIfMissing(adapter as never);
    assert.equal(document.querySelectorAll(".openerrata-annotation").length > 0, true);

    controller.hide();
    assert.equal(document.querySelectorAll(".openerrata-annotation").length, 0);
  } finally {
    restoreDom();
  }
});

test("AnnotationController render returns false when content root cannot be resolved", () => {
  const restoreDom = installDom("<!doctype html><html><body></body></html>");
  const controller = new AnnotationController();

  try {
    controller.setClaims([createClaim("Missing root claim")]);
    const adapter = {
      getContentRoot: () => null,
    };
    assert.equal(controller.render(adapter as never), false);
  } finally {
    restoreDom();
  }
});
