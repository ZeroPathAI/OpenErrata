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
