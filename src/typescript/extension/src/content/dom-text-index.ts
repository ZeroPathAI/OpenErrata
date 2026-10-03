import { NON_CONTENT_TAGS, WORD_SEPARATOR_TAGS } from "@openerrata/shared";
import {
  buildNormalizedTextIndex,
  normalizedLengthBefore,
  rawSpanOf,
  type NormalizedTextIndex,
} from "./normalized-text-index.js";

/**
 * The single text pipeline for page content (spec §3.8 "Content
 * normalization"). Adapters derive `contentText` and image offsets from it, the
 * claim mapper locates claims in it, and the mutation check compares against
 * it — so the text claims are matched in is exactly the text the API and the
 * LLM saw.
 *
 * Text is the root's text nodes in document order, skipping `NON_CONTENT_TAGS`
 * and adapter-excluded subtrees, with a word separator at the entry and exit of
 * every `WORD_SEPARATOR_TAGS` element (mirroring the API's parse5
 * traversal), then `normalizeContent`-normalized. Separators exist only in
 * the text: they have no DOM position.
 */
export interface DomTextIndex {
  readonly text: string;
  /** Images under the root matching the requested selector, with their offset in `text`. */
  readonly images: readonly IndexedImage[];
  /**
   * The text-node pieces that make up `text[start, end)`, in document order.
   * Empty when the span is empty or out of range.
   */
  piecesFor(start: number, end: number): DomTextPiece[];
}

/** A `[start, end)` slice of one text node's data. */
export interface DomTextPiece {
  node: Text;
  start: number;
  end: number;
}

export interface IndexedImage {
  element: HTMLImageElement;
  normalizedOffset: number;
}

interface DomTextIndexOptions {
  /** Subtrees that are not post content on this platform (beyond `NON_CONTENT_TAGS`). */
  exclude: (element: Element) => boolean;
  /** Images to report with their text offsets; omit to collect none. */
  imageSelector?: string;
}

interface RawChunk {
  rawStart: number;
  length: number;
  /** The text node the chunk came from, or null for a synthetic word separator. */
  node: Text | null;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const SHOW_ELEMENT_AND_TEXT = 0x1 | 0x4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

function isElementNode(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE;
}

function isTextNode(node: Node): node is Text {
  return node.nodeType === TEXT_NODE;
}

function isImageElement(element: Element): element is HTMLImageElement {
  return element.tagName.toLowerCase() === "img";
}

/** Elements whose text is never post content, on any platform. */
export function isNonContentElement(element: Element): boolean {
  return NON_CONTENT_TAGS.has(element.tagName.toLowerCase());
}

function chunkIndexAt(chunks: readonly RawChunk[], rawOffset: number): number {
  let low = 0;
  let high = chunks.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    const chunk = chunks[middle];
    if (chunk !== undefined && chunk.rawStart <= rawOffset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

function piecesForRawSpan(
  chunks: readonly RawChunk[],
  rawStart: number,
  rawEnd: number,
): DomTextPiece[] {
  const pieces: DomTextPiece[] = [];
  for (let index = chunkIndexAt(chunks, rawStart); index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined || chunk.rawStart >= rawEnd) break;
    if (chunk.node === null) continue;
    const start = Math.max(rawStart, chunk.rawStart) - chunk.rawStart;
    const end = Math.min(rawEnd, chunk.rawStart + chunk.length) - chunk.rawStart;
    if (end > start) {
      pieces.push({ node: chunk.node, start, end });
    }
  }
  return pieces;
}

export function buildDomTextIndex(root: Element, options: DomTextIndexOptions): DomTextIndex {
  const chunks: RawChunk[] = [];
  const rawParts: string[] = [];
  const rawImageOffsets: { element: HTMLImageElement; rawOffset: number }[] = [];
  let rawLength = 0;

  const append = (text: string, node: Text | null): void => {
    if (text.length === 0) return;
    chunks.push({ rawStart: rawLength, length: text.length, node });
    rawParts.push(text);
    rawLength += text.length;
  };

  // Separator elements still open in the traversal; when the walker leaves
  // one's subtree, it emits the closing separator (the API's "exit" phase).
  // A void element such as <br> closes at the next node.
  const openSeparators: Element[] = [];
  const closeExitedSeparators = (next: Node | null): void => {
    for (let top = openSeparators.at(-1); top !== undefined; top = openSeparators.at(-1)) {
      if (next !== null && top.contains(next)) return;
      openSeparators.pop();
      append(" ", null);
    }
  };

  const walker = root.ownerDocument.createTreeWalker(root, SHOW_ELEMENT_AND_TEXT, {
    acceptNode(node: Node): number {
      if (isElementNode(node) && (isNonContentElement(node) || options.exclude(node))) {
        return FILTER_REJECT;
      }
      return FILTER_ACCEPT;
    },
  });

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    closeExitedSeparators(node);
    if (isTextNode(node)) {
      append(node.data, node);
      continue;
    }
    if (!isElementNode(node)) continue;
    if (WORD_SEPARATOR_TAGS.has(node.tagName.toLowerCase())) {
      append(" ", null);
      openSeparators.push(node);
    }
    if (
      options.imageSelector !== undefined &&
      isImageElement(node) &&
      node.matches(options.imageSelector)
    ) {
      rawImageOffsets.push({ element: node, rawOffset: rawLength });
    }
  }
  closeExitedSeparators(null);

  const normalizedIndex: NormalizedTextIndex = buildNormalizedTextIndex(rawParts.join(""));

  return {
    text: normalizedIndex.normalized,
    images: rawImageOffsets.map(({ element, rawOffset }) => ({
      element,
      normalizedOffset: normalizedLengthBefore(normalizedIndex, rawOffset),
    })),
    piecesFor(start: number, end: number): DomTextPiece[] {
      const span = rawSpanOf(normalizedIndex, start, end);
      return span === null ? [] : piecesForRawSpan(chunks, span.rawStart, span.rawEnd);
    },
  };
}
