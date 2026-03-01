import {
  normalizeContent,
  isNonNullObject,
  CONTENT_BLOCK_SEPARATOR_TAGS,
  type ObservedImageOccurrence,
} from "@openerrata/shared";

/**
 * Clone an Element node. The DOM spec guarantees `cloneNode(true)` on an
 * Element returns an Element, but the TS return type is the wider `Node`.
 */
export function cloneElement(element: Element): Element {
  const clone = element.cloneNode(true);
  if (!(clone instanceof Element)) {
    throw new Error("cloneNode(true) on Element did not return Element");
  }
  return clone;
}

const JSON_LD_SELECTOR = 'script[type="application/ld+json"]';
const MAX_JSON_LD_DEPTH = 8;
const TREE_WALKER_TEXT_AND_ELEMENT = 0x1 | 0x4;

function parseIsoDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
  return parsed.toISOString();
}

export function readFirstMetaDateAsIso(
  document: Document,
  selectors: readonly string[],
): string | null {
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.getAttribute("content");
    const iso = parseIsoDate(value);
    if (iso !== null && iso.length > 0) return iso;
  }
  return null;
}

export function readFirstTimeDateAsIso(roots: readonly ParentNode[]): string | null {
  for (const root of roots) {
    const value = root.querySelector("time[datetime]")?.getAttribute("datetime");
    const iso = parseIsoDate(value);
    if (iso !== null && iso.length > 0) return iso;
  }
  return null;
}

function findDateInJsonLd(
  value: unknown,
  candidateKeys: ReadonlySet<string>,
  depth = 0,
): string | null {
  if (depth > MAX_JSON_LD_DEPTH || value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findDateInJsonLd(nested, candidateKeys, depth + 1);
      if (found !== null && found.length > 0) return found;
    }
    return null;
  }

  if (!isNonNullObject(value)) return null;
  const record = value;

  // Preserve caller-specified key priority (e.g. datePublished before dateCreated).
  for (const key of candidateKeys) {
    const nested = record[key];
    const iso = parseIsoDate(typeof nested === "string" ? nested : null);
    if (iso !== null && iso.length > 0) return iso;
  }

  for (const nested of Object.values(record)) {
    const found = findDateInJsonLd(nested, candidateKeys, depth + 1);
    if (found !== null && found.length > 0) return found;
  }

  return null;
}

export function readPublishedDateFromJsonLd(
  root: ParentNode,
  candidateKeys: ReadonlySet<string>,
): string | null {
  for (const script of root.querySelectorAll<HTMLScriptElement>(JSON_LD_SELECTOR)) {
    const text = script.textContent.trim();
    if (text.length === 0) continue;

    try {
      const parsed = JSON.parse(text) as unknown;
      const found = findDateInJsonLd(parsed, candidateKeys);
      if (found !== null && found.length > 0) return found;
    } catch {
      // Ignore malformed JSON-LD blobs.
    }
  }

  return null;
}

function uniqueNormalizedUrls(
  values: readonly (string | null | undefined)[],
  baseUrl: string,
): string[] {
  const uniqueUrls = new Set<string>();

  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length === 0 || trimmed.startsWith("data:")) continue;

    try {
      uniqueUrls.add(new URL(trimmed, baseUrl).toString());
    } catch {
      // Ignore malformed URLs in extracted content.
    }
  }

  return Array.from(uniqueUrls);
}

export function extractImageUrlsFromRoot(
  root: ParentNode,
  baseUrl: string,
  selector = "img[src]",
): string[] {
  const values = Array.from(root.querySelectorAll<HTMLImageElement>(selector)).map((image) =>
    image.getAttribute("src"),
  );
  return uniqueNormalizedUrls(values, baseUrl);
}

function normalizeImageUrl(value: string | null | undefined, baseUrl: string): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0 || trimmed.startsWith("data:")) return null;

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function readOptionalCaption(image: HTMLImageElement): string | undefined {
  const figureCaption = normalizeContent(
    image.closest("figure")?.querySelector("figcaption")?.textContent ?? "",
  );
  if (figureCaption.length > 0) return figureCaption;

  const altText = normalizeContent(image.getAttribute("alt") ?? "");
  if (altText.length > 0) return altText;

  const titleText = normalizeContent(image.getAttribute("title") ?? "");
  if (titleText.length > 0) return titleText;

  return undefined;
}

interface ExtractedContentWithImageOccurrences {
  contentText: string;
  imageUrls: string[];
  imageOccurrences: ObservedImageOccurrence[];
}

function isDocumentRoot(root: ParentNode): root is Document {
  return "createTreeWalker" in root && "defaultView" in root;
}

function hasOwnerDocument(
  root: ParentNode,
): root is ParentNode & { ownerDocument: Document | null } {
  return "ownerDocument" in root;
}

export function extractContentWithImageOccurrencesFromRoot(
  root: ParentNode,
  baseUrl: string,
  selector = "img[src]",
): ExtractedContentWithImageOccurrences {
  const targetImages = new Set(Array.from(root.querySelectorAll<HTMLImageElement>(selector)));
  const rawTextParts: string[] = [];
  let rawTextLength = 0;

  const uniqueImageUrls: string[] = [];
  const seenImageUrls = new Set<string>();
  const rawOccurrences: {
    rawOffset: number;
    sourceUrl: string;
    captionText?: string;
  }[] = [];

  const document = isDocumentRoot(root) ? root : hasOwnerDocument(root) ? root.ownerDocument : null;
  if (document === null) {
    throw new Error("Image occurrence extraction requires an owner document");
  }

  const defaultView = document.defaultView;
  if (defaultView === null) {
    throw new Error("Image occurrence extraction requires a default view");
  }

  const appendOccurrence = (image: HTMLImageElement): void => {
    const sourceUrl = normalizeImageUrl(image.getAttribute("src"), baseUrl);
    if (sourceUrl === null) return;

    if (!seenImageUrls.has(sourceUrl)) {
      seenImageUrls.add(sourceUrl);
      uniqueImageUrls.push(sourceUrl);
    }

    const captionText = readOptionalCaption(image);
    rawOccurrences.push({
      rawOffset: rawTextLength,
      sourceUrl,
      ...(captionText === undefined ? {} : { captionText }),
    });
  };

  if (root instanceof defaultView.HTMLImageElement && targetImages.has(root)) {
    appendOccurrence(root);
  }

  // Track open block elements so we can inject a trailing separator when
  // the TreeWalker moves past the end of a block element's subtree.  This
  // mirrors the "exit" phase in the server's parse5 traversal and ensures
  // that text ending at a block boundary (e.g. <div>about</div><span>Ali</span>)
  // still produces word-separated output.
  const openBlockElements: Element[] = [];

  const flushExitedBlocks = (currentNode: Node): void => {
    while (openBlockElements.length > 0) {
      const top = openBlockElements[openBlockElements.length - 1];
      if (top === undefined || top.contains(currentNode)) break;
      openBlockElements.pop();
      rawTextParts.push(" ");
      rawTextLength += 1;
    }
  };

  const walker = document.createTreeWalker(root, TREE_WALKER_TEXT_AND_ELEMENT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    flushExitedBlocks(node);

    if (node.nodeType === defaultView.Node.TEXT_NODE) {
      const value = node.nodeValue ?? "";
      rawTextParts.push(value);
      rawTextLength += value.length;
      continue;
    }

    // At this point node is an Element (TREE_WALKER_TEXT_AND_ELEMENT only
    // visits text nodes and element nodes, and text nodes were handled above).
    if (node instanceof defaultView.Element) {
      // Inject a space at the start and end of block-level elements so
      // adjacent elements with no whitespace text node between them still
      // produce word-separated output after normalizeContent.
      if (CONTENT_BLOCK_SEPARATOR_TAGS.has(node.tagName.toLowerCase())) {
        rawTextParts.push(" ");
        rawTextLength += 1;
        openBlockElements.push(node);
      }

      if (node instanceof defaultView.HTMLImageElement && targetImages.has(node)) {
        appendOccurrence(node);
      }
    }
  }

  // Flush separators for any block elements whose subtrees extended to the
  // end of the traversal.
  while (openBlockElements.length > 0) {
    openBlockElements.pop();
    rawTextParts.push(" ");
    rawTextLength += 1;
  }

  const rawText = rawTextParts.join("");
  const contentText = normalizeContent(rawText);
  const imageOccurrences: ObservedImageOccurrence[] = rawOccurrences.map(
    (occurrence, originalIndex) => {
      const normalizedTextOffset = normalizeContent(rawText.slice(0, occurrence.rawOffset)).length;
      return {
        originalIndex,
        normalizedTextOffset,
        sourceUrl: occurrence.sourceUrl,
        ...(occurrence.captionText === undefined ? {} : { captionText: occurrence.captionText }),
      };
    },
  );

  return {
    contentText,
    imageUrls: uniqueImageUrls,
    imageOccurrences,
  };
}
