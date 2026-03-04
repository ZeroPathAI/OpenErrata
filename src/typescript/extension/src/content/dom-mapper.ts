import {
  normalizeContent,
  TYPOGRAPHIC_CHAR_MAP,
  ZERO_WIDTH_CHAR_REGEX,
  type InvestigationClaim,
} from "@openerrata/shared";

// ── Public types ──────────────────────────────────────────────────────────

export interface DomAnnotation {
  claim: InvestigationClaim;
  range: Range | null;
  matched: boolean;
}

interface MapClaimsToDomOptions {
  allowFuzzy?: boolean;
}

interface NormalizedTextIndex {
  normalized: string;
  normalizedToRaw: number[];
}

interface CodePointWithRawIndex {
  value: string;
  rawIndex: number;
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

// ── Main mapper (spec §2.8 – tiered matching) ────────────────────────────

/**
 * Map each claim to a DOM `Range` inside `root` using a tiered strategy:
 *
 * 1. **Exact unique substring** — single occurrence in `root.textContent`.
 * 2. **Context-scoped** — locate `claim.context`, then find `claim.text`
 *    within that context span.
 * 3. **First occurrence** — when the text exists but isn't unique and
 *    context disambiguation failed, use the first occurrence rather than
 *    the expensive fuzzy search.
 * 4. **Fuzzy (Levenshtein)** — sliding-window search for the best
 *    approximate match. On large pages, scoped to a context-local window.
 */
export function mapClaimsToDom(
  claims: InvestigationClaim[],
  root: Element,
  options: MapClaimsToDomOptions = {},
): DomAnnotation[] {
  const allowFuzzy = options.allowFuzzy ?? true;
  const fullText = root.textContent;
  const t0 = performance.now();
  const fullTextIndex = buildNormalizedTextIndex(fullText);
  const normalizedFullText = fullTextIndex.normalized;
  const indexMs = performance.now() - t0;
  if (indexMs > 50) {
    console.warn(
      `[openerrata] buildNormalizedTextIndex took ${indexMs.toFixed(1)}ms ` +
        `(${fullText.length} raw chars → ${normalizedFullText.length} normalized chars)`,
    );
  }

  return claims.map((claim) => {
    const normalizedClaimText = normalizeContent(claim.text);
    const normalizedContext = normalizeContent(claim.context);
    if (normalizedClaimText.length === 0) {
      return { claim, range: null, matched: false };
    }

    // ── Tier 1: exact unique substring ───────────────────────────────────
    const exactOffset = findUniqueExactMatch(normalizedFullText, normalizedClaimText);
    if (exactOffset !== null) {
      const mappedSpan = mapNormalizedSpanToRaw(
        fullTextIndex,
        exactOffset,
        normalizedClaimText.length,
      );
      if (mappedSpan) {
        const range = createRangeFromTextOffset(root, mappedSpan.offset, mappedSpan.length);
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
            const range = createRangeFromTextOffset(root, mappedSpan.offset, mappedSpan.length);
            if (range) return { claim, range, matched: true };
          }
        }
      }
    }

    // ── Tier 3: first occurrence fallback ────────────────────────────────
    // When claim text exists in the page but tier 1 rejected it (non-unique)
    // and context disambiguation failed, use the first occurrence. This is
    // O(n) and avoids the catastrophic O(n²) fuzzy search that would
    // otherwise freeze the main thread on large articles.
    const firstIdx = normalizedFullText.indexOf(normalizedClaimText);
    if (firstIdx !== -1) {
      const mappedSpan = mapNormalizedSpanToRaw(
        fullTextIndex,
        firstIdx,
        normalizedClaimText.length,
      );
      if (mappedSpan) {
        const range = createRangeFromTextOffset(root, mappedSpan.offset, mappedSpan.length);
        if (range) return { claim, range, matched: true };
      }
    }

    // ── Tier 4: fuzzy (Levenshtein sliding window) ───────────────────────
    // On short pages, search the full text. On long pages, scope the search
    // to a window around the context position to keep the O(n²) work bounded.
    if (allowFuzzy) {
      const fuzzyWindow = selectFuzzyWindow(
        normalizedFullText,
        normalizedContext,
        normalizedClaimText.length,
      );
      if (fuzzyWindow) {
        const fuzzyT0 = performance.now();
        const fuzzyResult = fuzzyFind(fuzzyWindow.text, normalizedClaimText);
        const fuzzyMs = performance.now() - fuzzyT0;
        if (fuzzyMs > 50) {
          console.warn(
            `[openerrata] fuzzy search for claim "${claim.id}" took ${fuzzyMs.toFixed(1)}ms`,
          );
        }
        if (fuzzyResult) {
          const mappedSpan = mapNormalizedSpanToRaw(
            fullTextIndex,
            fuzzyWindow.offset + fuzzyResult.offset,
            fuzzyResult.length,
          );
          if (mappedSpan) {
            const range = createRangeFromTextOffset(root, mappedSpan.offset, mappedSpan.length);
            if (range) return { claim, range, matched: true };
          }
        }
      }
    }

    // No match at all
    return { claim, range: null, matched: false };
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

  // For long pages, we need context to narrow the search region.
  if (normalizedContext.length === 0) return null;

  const contextIdx = fullText.indexOf(normalizedContext);
  if (contextIdx === -1) return null;

  // Center the window on the midpoint of the context span.
  const contextMid = contextIdx + Math.floor(normalizedContext.length / 2);
  const halfWindow = Math.floor(FUZZY_HAYSTACK_LIMIT / 2);
  const windowStart = Math.max(0, contextMid - halfWindow);
  const windowEnd = Math.min(fullText.length, windowStart + FUZZY_HAYSTACK_LIMIT);

  // Ensure the window is at least large enough for the needle.
  if (windowEnd - windowStart < needleLength) return null;

  return {
    text: fullText.substring(windowStart, windowEnd),
    offset: windowStart,
  };
}

function appendNormalizedSegment(
  rawCodePoints: CodePointWithRawIndex[],
  normalizedChars: string[],
  normalizedToRaw: number[],
): void {
  if (rawCodePoints.length === 0) return;

  const rawSegment = rawCodePoints.map((codePoint) => codePoint.value).join("");
  const nfcCodePoints = Array.from(rawSegment.normalize("NFC"));

  const rawNfdTokens: { token: string; rawIndex: number }[] = [];
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

    // Apply typographic replacements (e.g. curly quotes → straight) so that
    // the index-tracked normalized text matches normalizeContent() output.
    const replaced = TYPOGRAPHIC_CHAR_MAP.get(codePoint) ?? codePoint;
    for (let codeUnitIndex = 0; codeUnitIndex < replaced.length; codeUnitIndex += 1) {
      // Index by UTF-16 code unit so normalizedToRaw aligns with string offsets.
      normalizedChars.push(replaced.charAt(codeUnitIndex));
      normalizedToRaw.push(mappedRawIndex);
    }
  }
}

/**
 * Exported for parity testing against `normalizeContent`. The invariant
 * `buildNormalizedTextIndex(text).normalized === normalizeContent(text)` must
 * hold for all inputs — any violation means the index-tracked normalizer has
 * drifted from the shared normalizer and claim matching will silently break.
 */
export function buildNormalizedTextIndex(rawText: string): NormalizedTextIndex {
  const normalizedChars: string[] = [];
  const normalizedToRaw: number[] = [];
  let pendingWhitespaceStart: number | null = null;
  let segmentCodePoints: CodePointWithRawIndex[] = [];

  const flushSegment = () => {
    appendNormalizedSegment(segmentCodePoints, normalizedChars, normalizedToRaw);
    segmentCodePoints = [];
  };

  for (let rawIndex = 0; rawIndex < rawText.length; ) {
    const codePoint = rawText.codePointAt(rawIndex);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const codeUnitLength = char.length;

    // Strip zero-width characters before anything else. U+200B–U+200D and
    // U+FEFF are not matched by \s, so without this guard they look like
    // non-whitespace, cause pending whitespace to be emitted, and then
    // get stripped in appendNormalizedSegment — leaving a spurious space.
    if (ZERO_WIDTH_CHAR_REGEX.test(char)) {
      rawIndex += codeUnitLength;
      continue;
    }

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
function createRangeFromTextOffset(root: Element, offset: number, length: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let charsSeen = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!(node instanceof Text)) continue;
    const textNode = node;
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
