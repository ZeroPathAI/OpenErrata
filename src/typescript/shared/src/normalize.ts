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
 * Typographic characters that should be replaced with their ASCII
 * equivalents so that content differing only in "smart" punctuation
 * (curly quotes, em/en dashes, ellipses, etc.) hashes and matches
 * identically.
 */
const TYPOGRAPHIC_REPLACEMENTS: readonly [pattern: RegExp, replacement: string][] = [
  [/[\u201C\u201D]/g, '"'], // Left/right double quotation marks → "
  [/[\u2018\u2019]/g, "'"], // Left/right single quotation marks → '
  [/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-"], // Hyphens + en/em/horizontal dashes → -
  [/\u2026/g, "..."], // Horizontal ellipsis → ...
];

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
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // Remove zero-width characters
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
