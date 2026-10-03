import { normalizeContent, type InvestigationClaim } from "@openerrata/shared";
import type { DomTextIndex, DomTextPiece } from "./dom-text-index.js";

/**
 * Where a claim sits in the page: the text-node pieces covering it, in
 * document order. An unmatched claim has no pieces (spec §2.4.1 "Match
 * failure": shown in the popup, not annotated inline).
 */
export type DomAnnotation =
  | { claim: InvestigationClaim; matched: true; pieces: DomTextPiece[] }
  | { claim: InvestigationClaim; matched: false };

interface MapClaimsToDomOptions {
  /**
   * Allow approximate matches (first of several occurrences, then Levenshtein).
   * Off when only a high-confidence position is useful (e.g. scrolling to a claim).
   */
  allowFuzzy?: boolean;
}

/**
 * Maximum haystack length for the O(n²) fuzzy Levenshtein sliding-window
 * search. When the full normalized text exceeds this limit, fuzzy search
 * is scoped to a local window around the claim's context position rather
 * than searching the entire article. This prevents catastrophic main-thread
 * blocking on large articles (e.g. Wikipedia pages exceeding 100K characters)
 * while still providing fuzzy matching for every claim that has context.
 */
const FUZZY_HAYSTACK_LIMIT = 15_000;

// ── Main mapper (spec §2.4.1 – tiered matching) ──────────────────────────

/**
 * Map each claim to the page text it quotes, using a tiered strategy over the
 * content text index — the same normalized text (block separators included)
 * the API and the LLM saw:
 *
 * 1. **Exact unique substring** — single occurrence in the content text.
 * 2. **Context-scoped** — locate `claim.context`, then find `claim.text`
 *    within that context span.
 * 3. **Fuzzy (Levenshtein)** — sliding-window search for the best
 *    approximate match. On large pages, scoped to a context-local window.
 *
 * When `allowFuzzy` is true (default), a **first occurrence** fallback runs
 * before the expensive fuzzy search: if the text exists but isn't unique and
 * context disambiguation failed, the first occurrence is used.
 */
export function mapClaimsToDom(
  claims: InvestigationClaim[],
  textIndex: DomTextIndex,
  options: MapClaimsToDomOptions = {},
): DomAnnotation[] {
  const allowFuzzy = options.allowFuzzy ?? true;
  const fullText = textIndex.text;

  const matchAt = (
    claim: InvestigationClaim,
    offset: number,
    length: number,
  ): DomAnnotation | null => {
    const pieces = textIndex.piecesFor(offset, offset + length);
    return pieces.length === 0 ? null : { claim, matched: true, pieces };
  };

  return claims.map((claim): DomAnnotation => {
    const claimText = normalizeContent(claim.text);
    const context = normalizeContent(claim.context);
    if (claimText.length === 0) {
      return { claim, matched: false };
    }

    // ── Tier 1: exact unique substring ───────────────────────────────────
    const exactOffset = findUniqueExactMatch(fullText, claimText);
    if (exactOffset !== null) {
      const match = matchAt(claim, exactOffset, claimText.length);
      if (match) return match;
    }

    // ── Tier 2: context-scoped search ────────────────────────────────────
    if (context.length > 0) {
      const contextIdx = fullText.indexOf(context);
      const relIdx = context.indexOf(claimText);
      if (contextIdx !== -1 && relIdx !== -1) {
        const match = matchAt(claim, contextIdx + relIdx, claimText.length);
        if (match) return match;
      }
    }

    if (allowFuzzy) {
      // First occurrence fallback — O(n), and avoids the O(n²) fuzzy search
      // when the text exists but is ambiguous.
      const firstIdx = fullText.indexOf(claimText);
      if (firstIdx !== -1) {
        const match = matchAt(claim, firstIdx, claimText.length);
        if (match) return match;
      }

      const fuzzyWindow = selectFuzzyWindow(fullText, context, claimText.length);
      if (fuzzyWindow) {
        const fuzzyT0 = performance.now();
        const fuzzyResult = fuzzyFind(fuzzyWindow.text, claimText);
        const fuzzyMs = performance.now() - fuzzyT0;
        if (fuzzyMs > 50) {
          console.warn(
            `[openerrata] fuzzy search for claim "${claim.id}" took ${fuzzyMs.toFixed(1)}ms`,
          );
        }
        if (fuzzyResult) {
          const match = matchAt(claim, fuzzyWindow.offset + fuzzyResult.offset, fuzzyResult.length);
          if (match) return match;
        }
      }
    }

    return { claim, matched: false };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Choose the haystack region for the fuzzy search. On short pages the full
 * text is returned. On long pages, a window of at most `FUZZY_HAYSTACK_LIMIT`
 * characters centered on the context location is returned so that the O(n²)
 * Levenshtein work stays bounded. Returns null when the haystack is too long
 * and no context is available to scope the window.
 */
function selectFuzzyWindow(
  fullText: string,
  normalizedContext: string,
  needleLength: number,
): { text: string; offset: number } | null {
  if (fullText.length <= FUZZY_HAYSTACK_LIMIT) {
    return { text: fullText, offset: 0 };
  }

  if (normalizedContext.length === 0) return null;

  const contextIdx = fullText.indexOf(normalizedContext);
  if (contextIdx === -1) return null;

  const contextMid = contextIdx + Math.floor(normalizedContext.length / 2);
  const halfWindow = Math.floor(FUZZY_HAYSTACK_LIMIT / 2);
  const windowStart = Math.max(0, contextMid - halfWindow);
  const windowEnd = Math.min(fullText.length, windowStart + FUZZY_HAYSTACK_LIMIT);

  if (windowEnd - windowStart < needleLength) return null;

  return {
    text: fullText.substring(windowStart, windowEnd),
    offset: windowStart,
  };
}

function findUniqueExactMatch(haystack: string, needle: string): number | null {
  const firstIdx = haystack.indexOf(needle);
  if (firstIdx === -1) return null;

  const secondIdx = haystack.indexOf(needle, firstIdx + needle.length);
  return secondIdx === -1 ? firstIdx : null;
}

/**
 * Sliding-window fuzzy search using Levenshtein distance.
 * Returns the best-matching substring's offset and length, or null if the
 * best match exceeds a distance threshold (40 % of needle length).
 */
function fuzzyFind(haystack: string, needle: string): { offset: number; length: number } | null {
  if (needle.length === 0 || haystack.length === 0) return null;

  const maxDist = Math.ceil(needle.length * 0.4);
  let bestDist = maxDist + 1;
  let bestOffset = -1;
  let bestLength = needle.length;

  // Slide a window around the needle length (± 20 %)
  const minWin = Math.max(1, Math.floor(needle.length * 0.8));
  const maxWin = Math.ceil(needle.length * 1.2);

  for (let winLen = minWin; winLen <= maxWin; winLen++) {
    for (let i = 0; i <= haystack.length - winLen; i++) {
      const candidate = haystack.substring(i, i + winLen);
      const candidateMaxDist = Math.min(maxDist, bestDist - 1);
      if (candidateMaxDist < 0) break;
      const dist = levenshteinWithin(needle, candidate, candidateMaxDist);
      if (dist !== null && dist < bestDist) {
        bestDist = dist;
        bestOffset = i;
        bestLength = winLen;
      }
      // Early exit on perfect match
      if (dist === 0) return { offset: i, length: winLen };
    }
  }

  if (bestOffset !== -1) {
    return { offset: bestOffset, length: bestLength };
  }

  return null;
}

/**
 * Bounded dynamic-programming Levenshtein distance.
 * Returns null when distance exceeds maxDist.
 */
function levenshteinWithin(a: string, b: string, maxDist: number): number | null {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > maxDist) {
    return null;
  }

  // Use two rows and evaluate only the bounded band around the diagonal.
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j += 1) {
    prev[j] = j;
  }

  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    const from = Math.max(1, i - maxDist);
    const to = Math.min(n, i + maxDist);

    for (let j = 1; j < from; j += 1) {
      curr[j] = Number.POSITIVE_INFINITY;
    }

    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = from; j <= to; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const prevAtJ = prev[j];
      const currAtJMinus1 = curr[j - 1];
      const prevAtJMinus1 = prev[j - 1];
      if (prevAtJ === undefined || currAtJMinus1 === undefined || prevAtJMinus1 === undefined) {
        throw new Error("Levenshtein matrix index is out of bounds");
      }

      const value = Math.min(
        prevAtJ + 1, // deletion
        currAtJMinus1 + 1, // insertion
        prevAtJMinus1 + cost, // substitution
      );
      curr[j] = value;
      rowMin = Math.min(rowMin, value);
    }

    for (let j = to + 1; j <= n; j += 1) {
      curr[j] = Number.POSITIVE_INFINITY;
    }

    if (rowMin > maxDist) {
      return null;
    }

    // Swap rows
    [prev, curr] = [curr, prev];
  }

  const result = prev[n];
  if (result === undefined) {
    throw new Error("Levenshtein distance index is out of bounds");
  }

  return result <= maxDist ? result : null;
}
