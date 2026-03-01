import { NON_CONTENT_TAGS, normalizeContent } from "./normalize.js";

// ---------------------------------------------------------------------------
// Shared heading detection for Wikipedia Parsoid and legacy HTML formats.
//
// Both the browser extension (DOM TreeWalker) and API server (parse5 traversal)
// need identical heading-level and heading-text logic to produce matching
// canonical output. These pure functions accept an environment-agnostic
// descriptor so both callers share one implementation — the same pattern
// used by shouldExcludeWikipediaElement below.
// ---------------------------------------------------------------------------

/**
 * Minimal descriptor that both DOM Elements and parse5 nodes can provide.
 * Used by the heading detection functions below.
 */
interface WikipediaElementDescriptor {
  tagName: string;
  classTokens: readonly string[];
}

/**
 * Extended descriptor that also carries text content and first-child-heading
 * information, needed for Parsoid wrapper detection and section-title checks.
 */
export interface WikipediaNodeDescriptor extends WikipediaElementDescriptor {
  /** Text content of this node (used for direct heading text). */
  textContent: string;
  /**
   * The first direct child element that is a heading tag (h2–h6), if any.
   * For Parsoid `<div class="mw-heading">` wrappers this is the inner `<h2>`.
   */
  firstChildHeading: { tagName: string; textContent: string } | null;
}

/** Parse an h2–h6 tag name to its numeric heading level, or null. */
export function headingLevelFromTag(tagName: string): number | null {
  const match = /^h([2-6])$/i.exec(tagName);
  return match?.[1] !== undefined ? Number(match[1]) : null;
}

/**
 * Returns true if `descriptor` is a Parsoid-style `<div class="mw-heading">`
 * wrapper that contains an inner heading element.
 */
function isParsoidHeadingWrapper(descriptor: WikipediaElementDescriptor): boolean {
  return (
    descriptor.tagName.toLowerCase() === "div" &&
    descriptor.classTokens.some((t) => t.toLowerCase() === "mw-heading")
  );
}

/**
 * Returns the heading level of a node, handling both direct heading elements
 * (`<h2>`, `<h3>`, …) and Parsoid-style `<div class="mw-heading">` wrappers
 * where the level comes from the inner child heading.
 */
export function effectiveHeadingLevel(node: WikipediaNodeDescriptor): number | null {
  const direct = headingLevelFromTag(node.tagName);
  if (direct !== null) return direct;
  if (isParsoidHeadingWrapper(node) && node.firstChildHeading !== null) {
    return headingLevelFromTag(node.firstChildHeading.tagName);
  }
  return null;
}

/**
 * Returns the text to use for section-title exclusion checks.
 * For Parsoid `<div class="mw-heading">` wrappers, reads the inner heading's
 * text (excluding sibling `<span class="mw-editsection">` spans). For direct
 * heading elements, checks for a `.mw-headline` child first (legacy format),
 * then falls back to the full text content.
 */
export function effectiveHeadingText(
  node: WikipediaNodeDescriptor,
  headlineTextContent?: string,
): string {
  if (isParsoidHeadingWrapper(node) && node.firstChildHeading !== null) {
    return node.firstChildHeading.textContent;
  }
  // Legacy format: prefer .mw-headline child text if the caller provides it.
  if (headlineTextContent !== undefined) {
    return headlineTextContent;
  }
  return node.textContent;
}

export const WIKIPEDIA_EXCLUDED_SECTION_TITLES = [
  "references",
  "notes",
  "further reading",
  "external links",
  "bibliography",
  "sources",
  "citations",
] as const;

const WIKIPEDIA_EXCLUDED_CLASS_TOKENS = [
  // Navigation / metadata
  "mw-editsection",
  "catlinks",
  "printfooter",
  // References / footnotes
  "references",
  "mw-references-wrap",
  "reflist",
  // Navigation boxes (don't contain article prose)
  "noprint",
  "navbox",
  "vertical-navbox",
  // Interactive UI injected by Wikipedia's JavaScript — not present in the
  // Wikipedia Parse API response and not article content.
  "mw-collapsible-toggle", // "show"/"hide" toggle buttons on collapsible infobox rows
  "mw-tmh-player", // Video/audio player wrapper added by TimedMediaHandler JS
  // (contains "Duration: N seconds." and time display)
] as const;

const WIKIPEDIA_EXCLUDED_SECTION_TITLE_SET = new Set<string>(WIKIPEDIA_EXCLUDED_SECTION_TITLES);
const WIKIPEDIA_EXCLUDED_CLASS_TOKEN_SET = new Set<string>(WIKIPEDIA_EXCLUDED_CLASS_TOKENS);

export function normalizeWikipediaSectionTitle(value: string): string {
  return normalizeContent(value).toLowerCase();
}

export function isExcludedWikipediaSectionTitle(value: string): boolean {
  return WIKIPEDIA_EXCLUDED_SECTION_TITLE_SET.has(normalizeWikipediaSectionTitle(value));
}

function isExcludedWikipediaClassToken(token: string): boolean {
  return WIKIPEDIA_EXCLUDED_CLASS_TOKEN_SET.has(token.toLowerCase());
}

function isReferenceSupNode(tagName: string, classTokens: readonly string[]): boolean {
  return (
    tagName.toLowerCase() === "sup" &&
    classTokens.some((token) => token.toLowerCase() === "reference")
  );
}

function isExcludedWikipediaTag(tagName: string): boolean {
  return NON_CONTENT_TAGS.has(tagName.toLowerCase());
}

/**
 * Shared Wikipedia element exclusion predicate used by both the browser
 * adapter (DOM traversal) and API canonical fetcher (parse5 traversal).
 * Keeping this centralized prevents client/server canonicalization drift.
 */
export function shouldExcludeWikipediaElement(input: {
  tagName: string;
  classTokens: readonly string[];
}): boolean {
  if (isExcludedWikipediaTag(input.tagName)) {
    return true;
  }

  if (isReferenceSupNode(input.tagName, input.classTokens)) {
    return true;
  }

  return input.classTokens.some((token) => isExcludedWikipediaClassToken(token));
}
