/**
 * Block-level HTML elements whose boundaries are treated as word separators
 * during content normalization. Used by both the extension (DOM TreeWalker)
 * and API (parse5 traversal) to ensure identical output on compact HTML where
 * no whitespace text nodes exist between adjacent block elements.
 *
 * Must be kept in sync between client and server to prevent canonicalization drift.
 * Spec §3.8.
 */
/**
 * HTML tags that never contain article prose on any platform.
 * Text inside these elements is excluded unconditionally during
 * content extraction on both client and server.
 */
export const NON_CONTENT_TAGS = new Set(["script", "style", "noscript"]);

export const CONTENT_BLOCK_SEPARATOR_TAGS = new Set([
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "figcaption",
  "blockquote",
  "tr",
  "td",
  "th",
  "div",
]);

/**
 * Per-codepoint typographic character replacements. Each key is a single
 * Unicode code point that should be replaced with its ASCII equivalent.
 *
 * Used by both `normalizeContent` (string-level regex) and the extension's
 * index-tracked normalizer (`buildNormalizedTextIndex` in dom-mapper.ts).
 * Any change here must be reflected in both consumers.
 */
export const TYPOGRAPHIC_CHAR_MAP: ReadonlyMap<string, string> = new Map([
  ["\u201C", '"'], // Left double quotation mark
  ["\u201D", '"'], // Right double quotation mark
  ["\u2018", "'"], // Left single quotation mark
  ["\u2019", "'"], // Right single quotation mark
  ["\u2010", "-"], // Hyphen
  ["\u2011", "-"], // Non-breaking hyphen
  ["\u2012", "-"], // Figure dash
  ["\u2013", "-"], // En dash
  ["\u2014", "-"], // Em dash
  ["\u2015", "-"], // Horizontal bar
  ["\u2026", "..."], // Horizontal ellipsis
]);

/** Regex-based replacements derived from {@link TYPOGRAPHIC_CHAR_MAP} for string-level use. */
const TYPOGRAPHIC_REPLACEMENTS: readonly [pattern: RegExp, replacement: string][] = (() => {
  const groups = new Map<string, string[]>();
  for (const [char, replacement] of TYPOGRAPHIC_CHAR_MAP) {
    const existing = groups.get(replacement);
    if (existing) {
      existing.push(char);
    } else {
      groups.set(replacement, [char]);
    }
  }
  return Array.from(groups, ([replacement, chars]) => {
    const singleChar = chars[0];
    if (singleChar === undefined) {
      throw new Error("TYPOGRAPHIC_CHAR_MAP produced an empty replacement group");
    }
    const pattern = chars.length === 1 ? singleChar : `[${chars.join("")}]`;
    return [new RegExp(pattern, "g"), replacement] as [RegExp, string];
  });
})();

/**
 * Tests whether a single Unicode code point is a zero-width character that
 * should be removed during content normalization. Shared between
 * `normalizeContent` (string-level regex) and the extension's index-tracked
 * normalizer (`buildNormalizedTextIndex` in dom-mapper.ts) to prevent the
 * two implementations from diverging on which characters are stripped.
 */
export const ZERO_WIDTH_CHAR_REGEX = /[\u200B-\u200D\uFEFF]/;

/**
 * Normalize content text for consistent hashing.
 * Must produce identical output on client (extension) and server (API).
 * Spec §3.8.
 */
export function normalizeContent(raw: string): string {
  let text = raw.normalize("NFC");
  for (const [pattern, replacement] of TYPOGRAPHIC_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  return text
    .replace(new RegExp(ZERO_WIDTH_CHAR_REGEX.source, "g"), "")
    .replace(/\s+/g, " ") // Collapse whitespace
    .trim();
}

/**
 * SHA-256 hash of a string, returned as hex.
 * Uses crypto.subtle which works in both browsers and Node 18+.
 */
export async function hashContent(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
