import { normalizeContent, type InvestigationClaim } from "@openerrata/shared";

// ── Public types ──────────────────────────────────────────────────────────

export interface DomAnnotation {
  claim: InvestigationClaim;
  range: Range | null;
  matched: boolean;
}

interface NormalizedTextIndex {
  normalized: string;
  normalizedToRaw: number[];
}

interface CodePointWithRawIndex {
  value: string;
  rawIndex: number;
}

// ── Main mapper (spec §2.8 – three-tier matching) ─────────────────────────

/**
 * Map each claim to a DOM `Range` inside `root` using a three-tier strategy:
 *
 * 1. **Exact substring** — unique occurrence in `root.textContent`.
 * 2. **Context-scoped** — locate `claim.context`, then find `claim.text`
 *    within that context span.
 * 3. **Fuzzy (Levenshtein)** — sliding-window search for the best
 *    approximate match.
 */
export function mapClaimsToDom(
  claims: InvestigationClaim[],
  root: Element,
): DomAnnotation[] {
  const fullText = root.textContent;
  const fullTextIndex = buildNormalizedTextIndex(fullText);
  const normalizedFullText = fullTextIndex.normalized;

  return claims.map((claim) => {
    const normalizedClaimText = normalizeContent(claim.text);
    const normalizedContext = normalizeContent(claim.context);
    if (normalizedClaimText.length === 0) {
      return { claim, range: null, matched: false };
    }

    // ── Tier 1: exact substring ──────────────────────────────────────────
    const exactOffset = findUniqueExactMatch(normalizedFullText, normalizedClaimText);
    if (exactOffset !== null) {
      const mappedSpan = mapNormalizedSpanToRaw(
        fullTextIndex,
        exactOffset,
        normalizedClaimText.length,
      );
      if (mappedSpan) {
        const range = createRangeFromTextOffset(
          root,
          mappedSpan.offset,
          mappedSpan.length,
        );
        if (range) return { claim, range, matched: true };
      }
    }

    // ── Tier 2: context-scoped search ────────────────────────────────────
    if (normalizedContext.length > 0) {
      const contextIdx = normalizedFullText.indexOf(normalizedContext);
      if (contextIdx !== -1) {
        const relIdx = normalizedContext.indexOf(normalizedClaimText);
        if (relIdx !== -1) {
          const mappedSpan = mapNormalizedSpanToRaw(
            fullTextIndex,
            contextIdx + relIdx,
            normalizedClaimText.length,
          );
          if (mappedSpan) {
            const range = createRangeFromTextOffset(
              root,
              mappedSpan.offset,
              mappedSpan.length,
            );
            if (range) return { claim, range, matched: true };
          }
        }
      }
    }

    // ── Tier 3: fuzzy fallback (Levenshtein sliding window) ──────────────
    const fuzzyResult = fuzzyFind(normalizedFullText, normalizedClaimText);
    if (fuzzyResult) {
      const mappedSpan = mapNormalizedSpanToRaw(
        fullTextIndex,
        fuzzyResult.offset,
        fuzzyResult.length,
      );
      if (mappedSpan) {
        const range = createRangeFromTextOffset(
          root,
          mappedSpan.offset,
          mappedSpan.length,
        );
        if (range) return { claim, range, matched: true };
      }
    }

    // No match at all
    return { claim, range: null, matched: false };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

const ZERO_WIDTH_CHAR_REGEX = /[\u200B-\u200D\uFEFF]/u;

function appendNormalizedSegment(
  rawCodePoints: CodePointWithRawIndex[],
  normalizedChars: string[],
  normalizedToRaw: number[],
): void {
  if (rawCodePoints.length === 0) return;

  const rawSegment = rawCodePoints.map((codePoint) => codePoint.value).join("");
  const nfcCodePoints = Array.from(rawSegment.normalize("NFC"));

  const rawNfdTokens: Array<{ token: string; rawIndex: number }> = [];
  for (const codePoint of rawCodePoints) {
    for (const token of Array.from(codePoint.value.normalize("NFD"))) {
      rawNfdTokens.push({ token, rawIndex: codePoint.rawIndex });
    }
  }

  const nfcNfdTokens: string[] = [];
  const nfcTokenStartByCodePoint: number[] = [];
  for (const codePoint of nfcCodePoints) {
    nfcTokenStartByCodePoint.push(nfcNfdTokens.length);
    for (const token of Array.from(codePoint.normalize("NFD"))) {
      nfcNfdTokens.push(token);
    }
  }

  const tokensAligned =
    rawNfdTokens.length === nfcNfdTokens.length &&
    rawNfdTokens.every((token, index) => token.token === nfcNfdTokens[index]);

  for (const [i, codePoint] of nfcCodePoints.entries()) {
    if (ZERO_WIDTH_CHAR_REGEX.test(codePoint)) continue;

    let mappedRawIndex: number;
    if (tokensAligned) {
      const nfcTokenStart = nfcTokenStartByCodePoint[i];
      if (nfcTokenStart === undefined) {
        throw new Error("Normalized token alignment index is out of bounds");
      }
      const rawNfdToken = rawNfdTokens[nfcTokenStart];
      if (!rawNfdToken) {
        throw new Error("Normalized token mapping is out of bounds");
      }
      mappedRawIndex = rawNfdToken.rawIndex;
    } else {
      const fallbackCodePoint = rawCodePoints[Math.min(i, rawCodePoints.length - 1)];
      if (!fallbackCodePoint) {
        throw new Error("Raw code point mapping is out of bounds");
      }
      mappedRawIndex = fallbackCodePoint.rawIndex;
    }

    for (let j = 0; j < codePoint.length; j++) {
      const codeUnit = codePoint[j];
      if (codeUnit === undefined) {
        throw new Error("Unicode code unit mapping is out of bounds");
      }
      normalizedChars.push(codeUnit);
      normalizedToRaw.push(mappedRawIndex);
    }
  }
}

function buildNormalizedTextIndex(rawText: string): NormalizedTextIndex {
  const normalizedChars: string[] = [];
  const normalizedToRaw: number[] = [];
  let pendingWhitespaceStart: number | null = null;
  let segmentCodePoints: CodePointWithRawIndex[] = [];

  const flushSegment = () => {
    appendNormalizedSegment(segmentCodePoints, normalizedChars, normalizedToRaw);
    segmentCodePoints = [];
  };

  for (let rawIndex = 0; rawIndex < rawText.length;) {
    const codePoint = rawText.codePointAt(rawIndex);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const codeUnitLength = char.length;

    if (/\s/u.test(char)) {
      flushSegment();
      if (normalizedChars.length > 0 && pendingWhitespaceStart === null) {
        pendingWhitespaceStart = rawIndex;
      }
      rawIndex += codeUnitLength;
      continue;
    }

    if (pendingWhitespaceStart !== null) {
      normalizedChars.push(" ");
      normalizedToRaw.push(pendingWhitespaceStart);
      pendingWhitespaceStart = null;
    }

    segmentCodePoints.push({ value: char, rawIndex });
    rawIndex += codeUnitLength;
  }

  flushSegment();

  return {
    normalized: normalizedChars.join(""),
    normalizedToRaw,
  };
}

function mapNormalizedSpanToRaw(
  textIndex: NormalizedTextIndex,
  normalizedOffset: number,
  normalizedLength: number,
): { offset: number; length: number } | null {
  if (normalizedLength <= 0) return null;

  const normalizedEnd = normalizedOffset + normalizedLength - 1;
  const rawStart = textIndex.normalizedToRaw[normalizedOffset];
  const rawEnd = textIndex.normalizedToRaw[normalizedEnd];
  if (rawStart === undefined || rawEnd === undefined) return null;

  return {
    offset: rawStart,
    length: rawEnd - rawStart + 1,
  };
}

function findUniqueExactMatch(haystack: string, needle: string): number | null {
  const firstIdx = haystack.indexOf(needle);
  if (firstIdx === -1) return null;

  const secondIdx = haystack.indexOf(needle, firstIdx + needle.length);
  return secondIdx === -1 ? firstIdx : null;
}

/**
 * Walk the text nodes under `root` and build a DOM `Range` that starts at
 * the given character `offset` (relative to `root.textContent`) and spans
 * `length` characters.
 */
function createRangeFromTextOffset(
  root: Element,
  offset: number,
  length: number,
): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let charsSeen = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  while (walker.nextNode()) {
    const textNode = walker.currentNode as Text;
    const nodeLen = textNode.length;

    // Find start node
    if (!startNode && charsSeen + nodeLen > offset) {
      startNode = textNode;
      startOffset = offset - charsSeen;
    }

    // Find end node
    if (startNode && charsSeen + nodeLen >= offset + length) {
      endNode = textNode;
      endOffset = offset + length - charsSeen;
      break;
    }

    charsSeen += nodeLen;
  }

  if (!startNode || !endNode) return null;

  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  } catch {
    return null;
  }
}

/**
 * Sliding-window fuzzy search using Levenshtein distance.
 * Returns the best-matching substring's offset and length, or null if the
 * best match exceeds a distance threshold (40 % of needle length).
 */
function fuzzyFind(
  haystack: string,
  needle: string,
): { offset: number; length: number } | null {
  if (!needle || !haystack) return null;

  const maxDist = Math.ceil(needle.length * 0.4);
  let bestDist = Infinity;
  let bestOffset = -1;
  let bestLength = needle.length;

  // Slide a window around the needle length (± 20 %)
  const minWin = Math.max(1, Math.floor(needle.length * 0.8));
  const maxWin = Math.ceil(needle.length * 1.2);

  for (let winLen = minWin; winLen <= maxWin; winLen++) {
    for (let i = 0; i <= haystack.length - winLen; i++) {
      const candidate = haystack.substring(i, i + winLen);
      const dist = levenshtein(needle, candidate);
      if (dist < bestDist) {
        bestDist = dist;
        bestOffset = i;
        bestLength = winLen;
      }
      // Early exit on perfect match
      if (dist === 0) return { offset: i, length: winLen };
    }
  }

  if (bestDist <= maxDist && bestOffset !== -1) {
    return { offset: bestOffset, length: bestLength };
  }

  return null;
}

/**
 * Standard dynamic-programming Levenshtein distance.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use a single flat array for the DP matrix (two-row optimisation)
  let prev = new Uint16Array(n + 1);
  let curr = new Uint16Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const prevAtJ = prev[j];
      const currAtJMinus1 = curr[j - 1];
      const prevAtJMinus1 = prev[j - 1];
      if (
        prevAtJ === undefined ||
        currAtJMinus1 === undefined ||
        prevAtJMinus1 === undefined
      ) {
        throw new Error("Levenshtein matrix index is out of bounds");
      }

      curr[j] = Math.min(
        prevAtJ + 1, // deletion
        currAtJMinus1 + 1, // insertion
        prevAtJMinus1 + cost, // substitution
      );
    }
    // Swap rows
    [prev, curr] = [curr, prev];
  }

  const distance = prev[n];
  if (distance === undefined) {
    throw new Error("Levenshtein distance index is out of bounds");
  }

  return distance;
}
