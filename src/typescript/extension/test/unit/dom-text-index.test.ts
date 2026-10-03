import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDomTextIndex, type DomTextPiece } from "../../src/content/dom-text-index.js";
import { requireElement, withDom } from "../helpers/dom.js";

const excludeNothing = (): boolean => false;

function piecesText(pieces: readonly DomTextPiece[]): string {
  return pieces.map((piece) => piece.node.data.slice(piece.start, piece.end)).join("|");
}

test("block boundaries separate words in the text but have no DOM position", () => {
  withDom("<div id='root'><p>Alpha</p><p>Beta</p></div>", (document) => {
    const index = buildDomTextIndex(requireElement(document, "#root"), { exclude: excludeNothing });
    assert.equal(index.text, "Alpha Beta");
    // The span crosses the separator: only the two text pieces are returned.
    assert.equal(piecesText(index.piecesFor(0, index.text.length)), "Alpha|Beta");
  });
});

test("line breaks separate words in the text but have no DOM position", () => {
  withDom("<div id='root'><p>is hard.<br>This work<br><br>(2) next</p></div>", (document) => {
    const index = buildDomTextIndex(requireElement(document, "#root"), { exclude: excludeNothing });
    assert.equal(index.text, "is hard. This work (2) next");
    const start = index.text.indexOf("hard.");
    assert.equal(
      piecesText(index.piecesFor(start, start + "hard. This work".length)),
      "hard.|This work",
    );
  });
});

test("non-content tags and excluded subtrees are left out of the text", () => {
  withDom(
    "<div id='root'>Kept<script>var x = 1;</script><style>p{}</style> text<sup class='ref'>[1]</sup> here.</div>",
    (document) => {
      const index = buildDomTextIndex(requireElement(document, "#root"), {
        exclude: (element) => element.classList.contains("ref"),
      });
      assert.equal(index.text, "Kept text here.");
      assert.equal(piecesText(index.piecesFor(0, index.text.length)), "Kept| text| here.");
    },
  );
});

test("pieces map normalized offsets back into the right text nodes", () => {
  withDom("<div id='root'>Say “hello<b>  world</b>” now</div>", (document) => {
    const index = buildDomTextIndex(requireElement(document, "#root"), { exclude: excludeNothing });
    assert.equal(index.text, 'Say "hello world" now');
    const start = index.text.indexOf("hello");
    const pieces = index.piecesFor(start, start + "hello world".length);
    assert.equal(piecesText(pieces), "hello|  world");
  });
});

test("image offsets are positions in the normalized text", () => {
  withDom(
    "<div id='root'><p>Before</p><img src='https://img.example/a.png'><p>After</p><img src='https://img.example/b.png'></div>",
    (document) => {
      const index = buildDomTextIndex(requireElement(document, "#root"), {
        exclude: excludeNothing,
        imageSelector: "img[src]",
      });
      assert.equal(index.text, "Before After");
      assert.deepEqual(
        index.images.map((image) => [image.element.getAttribute("src"), image.normalizedOffset]),
        [
          ["https://img.example/a.png", "Before".length],
          ["https://img.example/b.png", "Before After".length],
        ],
      );
    },
  );
});
