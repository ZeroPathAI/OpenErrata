import { normalizeContent } from "./normalize.js";

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
  "mw-editsection",
  "references",
  "mw-references-wrap",
  "reflist",
  "noprint",
  "navbox",
  "vertical-navbox",
  "catlinks",
  "printfooter",
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
  const normalized = tagName.toLowerCase();
  // noscript is excluded because its content differs between environments: browsers
  // with scripting enabled expose it as a raw text node (containing literal HTML), while
  // scripting-disabled parsers (parse5, jsdom) expose it as parsed child elements.
  // Either way, noscript content is metadata/tracking (e.g. the CentralAutoLogin
  // pixel Wikipedia places in #mw-content-text), never article text.
  return normalized === "script" || normalized === "style" || normalized === "noscript";
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
