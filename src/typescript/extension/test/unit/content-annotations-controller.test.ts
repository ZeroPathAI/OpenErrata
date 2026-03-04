import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { InvestigationClaim } from "@openerrata/shared";
import {
  ANNOTATION_CLAIM_ID_ATTRIBUTE,
  ANNOTATION_SELECTOR,
} from "../../src/content/annotation-dom";
import { AnnotationController } from "../../src/content/annotations";
import { renderAnnotations, clearAnnotations } from "../../src/content/annotator";
import { mapClaimsToDom } from "../../src/content/dom-mapper";

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

function createClaim(
  text: string,
  options?: { id?: InvestigationClaim["id"]; context?: string },
): InvestigationClaim {
  return {
    id: options?.id ?? ("claim-1" as InvestigationClaim["id"]),
    text,
    context: options?.context ?? text,
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
    const renderedMark = document.querySelector<HTMLElement>(".openerrata-annotation");
    if (!renderedMark) {
      throw new Error("Expected annotation mark to be rendered");
    }
    assert.equal(renderedMark.getAttribute(ANNOTATION_CLAIM_ID_ATTRIBUTE), claim.id);

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

// ── renderAnnotations with exclusion filter ─────────────────────────────────

test("renderAnnotations with filter renders single-text-node matches identically to no-filter", () => {
  // Regression: when shouldExcludeElement was present, renderAnnotations forced
  // highlightFragments for ALL ranges. highlightFragments uses a TreeWalker
  // starting from range.commonAncestorContainer — but when that's a Text node
  // (single-text-node match), nextNode() has no descendants to visit, so zero
  // marks were rendered. The fix uses surroundContents for single-text-node
  // ranges even with a filter.
  const restoreDom = installDom(
    '<!doctype html><html><body><article id="root">' +
      "The climate has changed significantly over the past century." +
      "</article></body></html>",
  );

  try {
    const root = document.getElementById("root");
    if (!(root instanceof Element)) {
      throw new Error("Missing #root test fixture");
    }

    const claim = createClaim("climate has changed significantly");

    // A filter that excludes nothing — should produce identical output to no filter
    const neverExclude = (_el: Element): boolean => false;

    const annotations = mapClaimsToDom([claim], root, { allowFuzzy: false });
    assert.equal(annotations[0]?.matched, true, "Claim should match");

    // Render with filter
    renderAnnotations(annotations, neverExclude);
    const marksWithFilter = root.querySelectorAll(ANNOTATION_SELECTOR).length;

    // Clean up
    clearAnnotations();

    // Render without filter (baseline)
    renderAnnotations(annotations);
    const marksWithoutFilter = root.querySelectorAll(ANNOTATION_SELECTOR).length;

    clearAnnotations();

    assert.ok(marksWithFilter > 0, "Filter path must render at least one mark");
    assert.equal(
      marksWithFilter,
      marksWithoutFilter,
      "Filter and no-filter paths must produce the same number of marks for single-text-node ranges",
    );
  } finally {
    restoreDom();
  }
});

test("renderAnnotations with filter skips excluded text nodes in multi-node ranges", () => {
  // When a range spans excluded elements (e.g. citation superscripts),
  // the filter should prevent marks from wrapping those excluded text nodes.
  const restoreDom = installDom(
    '<!doctype html><html><body><article id="root">' +
      'The treaty was signed<sup class="ref">[1]</sup> by all parties.' +
      "</article></body></html>",
  );

  try {
    const root = document.getElementById("root");
    if (!(root instanceof Element)) {
      throw new Error("Missing #root test fixture");
    }

    const claim = createClaim("The treaty was signed by all parties.");
    const shouldExclude = (el: Element): boolean =>
      el.tagName === "SUP" && el.classList.contains("ref");

    const annotations = mapClaimsToDom([claim], root, {
      allowFuzzy: false,
      shouldExcludeElement: shouldExclude,
    });
    assert.equal(annotations[0]?.matched, true, "Claim should match with filter");

    renderAnnotations(annotations, shouldExclude);

    // Marks should exist on the prose text nodes
    const marks = root.querySelectorAll(ANNOTATION_SELECTOR);
    assert.ok(marks.length > 0, "Should render annotation marks");

    // No mark should contain the excluded "[1]" text
    for (const mark of marks) {
      assert.ok(
        !mark.textContent.includes("[1]"),
        "Annotation mark must not wrap excluded citation text",
      );
    }

    clearAnnotations();
  } finally {
    restoreDom();
  }
});
