import {
  normalizeContent,
  isNonNullObject,
  utf8ByteLength,
  type ObservedImageOccurrence,
} from "@openerrata/shared";
import { cloneWithoutAnnotations } from "../annotation-dom.js";
import { buildDomTextIndex, isNonContentElement, type DomTextIndex } from "../dom-text-index.js";

const JSON_LD_SELECTOR = 'script[type="application/ld+json"]';
const MAX_JSON_LD_DEPTH = 8;

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

/** Parsed JSON-LD blocks under `root`. Pages ship malformed blocks as-is; those are skipped. */
export function readJsonLdBlocks(root: ParentNode): unknown[] {
  const blocks: unknown[] = [];
  for (const script of root.querySelectorAll<HTMLScriptElement>(JSON_LD_SELECTOR)) {
    const text = script.textContent.trim();
    if (text.length === 0) continue;
    try {
      const block: unknown = JSON.parse(text);
      blocks.push(block);
    } catch {
      // Not our JSON to fix; a malformed block carries no usable metadata.
    }
  }
  return blocks;
}

export function readPublishedDateFromJsonLd(
  root: ParentNode,
  candidateKeys: ReadonlySet<string>,
): string | null {
  for (const block of readJsonLdBlocks(root)) {
    const found = findDateInJsonLd(block, candidateKeys);
    if (found !== null && found.length > 0) return found;
  }
  return null;
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

/**
 * Iframe src patterns that embed video or audio content. Generic iframes
 * (e.g. Manifold Market prediction widgets, tweet embeds) are interactive
 * content, not video, and should not cause a post to be skipped.
 */
const VIDEO_IFRAME_SRC_PATTERNS = [
  /youtube\.com\//i,
  /youtu\.be\//i,
  /vimeo\.com\//i,
  /dailymotion\.com\//i,
  /twitch\.tv\//i,
  /wistia\.com\//i,
  /loom\.com\//i,
  /spotify\.com\/embed\/episode/i,
  /player\.simplecast\.com\//i,
] as const;

function isVideoIframe(iframe: Element): boolean {
  const src = iframe.getAttribute("src") ?? "";
  return VIDEO_IFRAME_SRC_PATTERNS.some((pattern) => pattern.test(src));
}

/**
 * Detect whether a content root contains actual video/audio media.
 * Returns true for `<video>` elements or iframes embedding known video
 * platforms. Returns false for generic iframes (widgets, embeds, etc.).
 */
export function hasVideoContent(root: ParentNode): boolean {
  if (root.querySelector("video") !== null) return true;
  return Array.from(root.querySelectorAll("iframe")).some(isVideoIframe);
}

/** Post content read from the live DOM through the shared text pipeline. */
interface ExtractedContent {
  contentText: string;
  imageOccurrences: ObservedImageOccurrence[];
}

/**
 * Content text and image occurrences of `root`, via the shared text index
 * (`buildDomTextIndex`) — the same pipeline the claim mapper and the mutation
 * check use.
 */
export function extractContent(
  root: Element,
  options: { exclude: (element: Element) => boolean; imageSelector: string; baseUrl: string },
): ExtractedContent {
  const textIndex = buildDomTextIndex(root, {
    exclude: options.exclude,
    imageSelector: options.imageSelector,
  });
  return {
    contentText: textIndex.text,
    imageOccurrences: imageOccurrencesOf(textIndex, options.baseUrl),
  };
}

function imageOccurrencesOf(textIndex: DomTextIndex, baseUrl: string): ObservedImageOccurrence[] {
  return toImageOccurrences(
    textIndex.images.map((image) => ({
      element: image.element,
      normalizedTextOffset: image.normalizedOffset,
    })),
    baseUrl,
  );
}

/**
 * Occurrences of images that sit outside the text root (e.g. tweet media
 * below the tweet text), all placed at `normalizedTextOffset`.
 */
export function detachedImageOccurrences(
  scope: ParentNode,
  options: { imageSelector: string; baseUrl: string; normalizedTextOffset: number },
): ObservedImageOccurrence[] {
  return toImageOccurrences(
    Array.from(scope.querySelectorAll<HTMLImageElement>(options.imageSelector)).map((element) => ({
      element,
      normalizedTextOffset: options.normalizedTextOffset,
    })),
    options.baseUrl,
  );
}

function toImageOccurrences(
  images: readonly { element: HTMLImageElement; normalizedTextOffset: number }[],
  baseUrl: string,
): ObservedImageOccurrence[] {
  const occurrences: ObservedImageOccurrence[] = [];
  for (const { element, normalizedTextOffset } of images) {
    const sourceUrl = normalizeImageUrl(element.getAttribute("src"), baseUrl);
    if (sourceUrl === null) continue;
    const captionText = readOptionalCaption(element);
    occurrences.push({
      originalIndex: occurrences.length,
      normalizedTextOffset,
      sourceUrl,
      ...(captionText === undefined ? {} : { captionText }),
    });
  }
  return occurrences;
}

/**
 * HTML of `root` as transported to the API: OpenErrata's own highlight marks
 * unwrapped, and the same subtrees removed that text extraction skips.
 */
export function serializeContentHtml(
  root: Element,
  exclusionFilter: (root: Element) => (element: Element) => boolean,
): string {
  const clone = cloneWithoutAnnotations(root);
  const exclude = exclusionFilter(clone);
  for (const element of Array.from(clone.querySelectorAll("*"))) {
    if (isNonContentElement(element) || exclude(element)) {
      element.remove();
    }
  }
  return clone.innerHTML;
}

/**
 * Optional page HTML is omitted when it is empty or larger than `maxBytes`,
 * so one oversized snapshot cannot push the whole request over the API's body
 * limit (the API then works from text alone).
 */
export function toTransportableHtml(html: string, maxBytes: number): string | undefined {
  if (html.length === 0) return undefined;
  return utf8ByteLength(html) <= maxBytes ? html : undefined;
}
