import assert from "node:assert/strict";
import { test } from "node:test";
import type { InvestigationClaim } from "@openerrata/shared";
import type { PlatformAdapter } from "../../src/content/adapters/index";
import { excludeNothing } from "../../src/content/adapters/model";
import {
  ANNOTATION_CLAIM_ID_ATTRIBUTE,
  ANNOTATION_SELECTOR,
} from "../../src/content/annotation-dom";
import { AnnotationController } from "../../src/content/annotations";
import { unwrapPieces, wrapAnnotations } from "../../src/content/annotator";
import { mapClaimsToDom } from "../../src/content/dom-mapper";
import { buildDomTextIndex } from "../../src/content/dom-text-index";
import { requireElement, withDom } from "../helpers/dom";

function createClaim(text: string, id = "claim-1"): InvestigationClaim {
  return {
    id: id as InvestigationClaim["id"],
    text,
    context: text,
    summary: "Claim summary",
    reasoning: "Claim reasoning",
    sources: [{ url: "https://example.com/source", title: "Source", snippet: "Snippet" }],
  };
}

function rootAdapter(exclude: (element: Element) => boolean = () => false): PlatformAdapter {
  return {
    platformKey: "LESSWRONG",
    matches: () => true,
    pageLocator: () => null,
    extract: () => ({ kind: "not_ready", reason: "hydrating" }),
    getContentRoot: (document) => document.getElementById("root"),
    contentExclusionFilter: () => exclude,
  };
}

test("AnnotationController highlights claims in the content root and re-applies them when the page drops them", () => {
  withDom('<article id="root">Earth is flat and orbits the sun.</article>', (document) => {
    const controller = new AnnotationController();
    const adapter = rootAdapter();
    const claim = createClaim("Earth is flat");

    assert.equal(controller.showClaims([claim], adapter), true);
    const mark = document.querySelector(ANNOTATION_SELECTOR);
    assert.equal(mark?.getAttribute(ANNOTATION_CLAIM_ID_ATTRIBUTE), claim.id);
    assert.equal(mark.textContent, "Earth is flat");
    assert.equal(controller.renderedAnchorFor(claim.id), mark);

    // A framework re-render replaces the text and our marks with it.
    requireElement(document, "#root").textContent = "Earth is flat and orbits the sun.";
    assert.equal(document.querySelectorAll(ANNOTATION_SELECTOR).length, 0);
    controller.reapplyIfMissing(adapter);
    assert.equal(document.querySelectorAll(ANNOTATION_SELECTOR).length, 1);

    controller.hide();
    assert.equal(document.querySelectorAll(ANNOTATION_SELECTOR).length, 0);
    assert.equal(controller.isVisible(), false);
    controller.show(adapter);
    assert.equal(document.querySelectorAll(ANNOTATION_SELECTOR).length, 1);

    controller.clearAll();
    assert.deepEqual(controller.getClaims(), []);
    assert.equal(document.querySelectorAll(ANNOTATION_SELECTOR).length, 0);
  });
});

test("AnnotationController reports a missing content root instead of rendering nothing silently", () => {
  withDom("<main></main>", () => {
    const controller = new AnnotationController();
    assert.equal(controller.showClaims([createClaim("Missing root claim")], rootAdapter()), false);
  });
});

test("clearing highlights restores the page's own text nodes without merging its neighbours", () => {
  withDom('<p id="root"></p>', (document) => {
    const root = requireElement(document, "#root");
    // Two adjacent text nodes the page (e.g. React) owns separately.
    const owned = document.createTextNode("Water boils at 50 degrees ");
    const neighbour = document.createTextNode("at sea level.");
    root.append(owned, neighbour);

    const index = buildDomTextIndex(root, { exclude: excludeNothing() });
    const pieces = wrapAnnotations(
      mapClaimsToDom([createClaim("boils at 50 degrees", "a"), createClaim("Water", "b")], index),
    );
    assert.equal(document.querySelectorAll(ANNOTATION_SELECTOR).length, 2);

    unwrapPieces(pieces);
    assert.equal(document.querySelectorAll(ANNOTATION_SELECTOR).length, 0);
    assert.deepEqual(Array.from(root.childNodes), [owned, neighbour]);
    assert.equal(owned.data, "Water boils at 50 degrees ");
    assert.equal(neighbour.data, "at sea level.");
  });
});

test("highlights never wrap excluded content inside a claim", () => {
  withDom(
    '<article id="root">The treaty was signed<sup class="ref">[1]</sup> by all parties.</article>',
    (document) => {
      const controller = new AnnotationController();
      controller.showClaims(
        [createClaim("The treaty was signed by all parties.")],
        rootAdapter((element) => element.classList.contains("ref")),
      );
      const marks = Array.from(document.querySelectorAll(ANNOTATION_SELECTOR));
      assert.deepEqual(
        marks.map((mark) => mark.textContent),
        ["The treaty was signed", " by all parties."],
      );
    },
  );
});
