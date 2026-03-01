/**
 * Block-level HTML elements whose boundaries are treated as word separators
 * during content normalization. Used by both the extension (DOM TreeWalker)
 * and API (parse5 traversal) to ensure identical output on compact HTML where
 * no whitespace text nodes exist between adjacent block elements.
 *
 * Must be kept in sync between client and server to prevent CONTENT_MISMATCH.
 * Spec §3.8.
 */
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
 * Normalize content text for consistent hashing.
 * Must produce identical output on client (extension) and server (API).
 * Spec §3.8.
 */
export function normalizeContent(raw: string): string {
  return raw
    .normalize("NFC")
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
