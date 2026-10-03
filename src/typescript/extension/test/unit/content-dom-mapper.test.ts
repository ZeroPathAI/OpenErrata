import assert from "node:assert/strict";
import { test } from "node:test";
import type { InvestigationClaim } from "@openerrata/shared";
import { mapClaimsToDom, type DomAnnotation } from "../../src/content/dom-mapper.js";
import { buildDomTextIndex, type DomTextIndex } from "../../src/content/dom-text-index.js";
import { requireElement, withDom } from "../helpers/dom.js";

function createClaim(text: string, context: string): InvestigationClaim {
  return {
    id: "claim-dom-1" as InvestigationClaim["id"],
    text,
    context,
    summary: "Claim summary",
    reasoning: "Claim reasoning",
    sources: [{ url: "https://example.com/source", title: "Source", snippet: "Snippet" }],
  };
}

function indexOf(
  document: Document,
  exclude: (element: Element) => boolean = () => false,
): DomTextIndex {
  return buildDomTextIndex(requireElement(document, "#root"), { exclude });
}

function mapOne(
  index: DomTextIndex,
  claim: InvestigationClaim,
  options?: { allowFuzzy?: boolean },
): DomAnnotation {
  const [annotation] = mapClaimsToDom([claim], index, options);
  if (annotation === undefined) throw new Error("Expected one annotation result");
  return annotation;
}

/** The page text a match covers, piece by piece. */
function matchedText(annotation: DomAnnotation): string | null {
  if (!annotation.matched) return null;
  return annotation.pieces.map((piece) => piece.node.data.slice(piece.start, piece.end)).join("|");
}

test("mapClaimsToDom preserves UTF-16 offset alignment after astral emoji", () => {
  withDom("<article id='root'>Prefix 😀 target text suffix.</article>", (document) => {
    const annotation = mapOne(
      indexOf(document),
      createClaim("target text", "Prefix 😀 target text suffix."),
    );
    assert.equal(matchedText(annotation), "target text");
  });
});

test("mapClaimsToDom matches claims through typographic characters without fuzzy fallback", () => {
  withDom(
    '<article id="root">“Hello,” she said—it’s a test… with dashes–and more.</article>',
    (document) => {
      const claim = createClaim('"Hello," she said-it\'s a test... with dashes-and more.', "");
      const annotation = mapOne(indexOf(document), claim, { allowFuzzy: false });
      assert.equal(annotation.matched, true, "Typographic chars must match via tier 1, not fuzzy");
    },
  );
});

test("mapClaimsToDom reads block boundaries as word breaks, like the API and the LLM", () => {
  // The API sends the LLM "...in 1969. Armstrong walked..." for these two
  // paragraphs; a claim quoting across them must still be found, and its
  // context must disambiguate the repeated sentence.
  withDom(
    "<article id='root'><p>Apollo 11 landed in 1969.</p><p>Armstrong walked first.</p>" +
      "<p>Apollo 11 landed in 1969.</p><p>Aldrin followed.</p></article>",
    (document) => {
      const annotation = mapOne(
        indexOf(document),
        createClaim("Apollo 11 landed in 1969.", "Apollo 11 landed in 1969. Aldrin followed."),
        { allowFuzzy: false },
      );
      assert.equal(annotation.matched, true);
      const secondParagraph = document.querySelectorAll("#root p")[2];
      assert.equal(annotation.pieces[0]?.node.parentElement, secondParagraph);
    },
  );
});

test("mapClaimsToDom falls back to first occurrence when claim text is non-unique", () => {
  withDom(
    "<article id='root'>North America is a continent. North America has many countries.</article>",
    (document) => {
      const annotation = mapOne(indexOf(document), createClaim("North America", ""));
      assert.equal(matchedText(annotation), "North America");
    },
  );
});

test("mapClaimsToDom can disable approximate matching via allowFuzzy: false", () => {
  withDom(
    "<article id='root'>The quick brown fox jumps over the lazy dog.</article>",
    (document) => {
      const nearMatchClaim = createClaim("quick brown fox jumps over lazy dog", "");
      assert.equal(mapOne(indexOf(document), nearMatchClaim).matched, true);
      assert.equal(mapOne(indexOf(document), nearMatchClaim, { allowFuzzy: false }).matched, false);
    },
  );
});

test("mapClaimsToDom strict mode rejects non-unique matches without disambiguating context", () => {
  withDom(
    "<article id='root'>North America is a continent. North America has many countries.</article>",
    (document) => {
      const annotation = mapOne(indexOf(document), createClaim("North America", ""), {
        allowFuzzy: false,
      });
      assert.equal(annotation.matched, false);
    },
  );
});

test("mapClaimsToDom matches a claim through excluded citation superscripts", () => {
  withDom(
    '<article id="root">The agreement<sup class="reference">[1]</sup> was signed<sup class="reference">[2]</sup> in Paris.</article>',
    (document) => {
      const isCitation = (element: Element): boolean =>
        element.tagName === "SUP" && element.classList.contains("reference");
      const claim = createClaim("The agreement was signed in Paris.", "");

      assert.equal(mapOne(indexOf(document), claim, { allowFuzzy: false }).matched, false);

      const annotation = mapOne(indexOf(document, isCitation), claim, { allowFuzzy: false });
      // Highlight pieces never include the excluded citation text.
      assert.equal(matchedText(annotation), "The agreement| was signed| in Paris.");
    },
  );
});
