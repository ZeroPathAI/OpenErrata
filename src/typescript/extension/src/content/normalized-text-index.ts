import { TYPOGRAPHIC_CHAR_MAP, ZERO_WIDTH_CHAR_REGEX } from "@openerrata/shared";

/**
 * `normalizeContent(raw)` together with, for every UTF-16 unit of the
 * normalized text, the span of raw text that produced it. This is what lets
 * offsets in normalized text (the text the API and the LLM see) be mapped back
 * to positions in the page.
 *
 * Invariant (tested): `buildNormalizedTextIndex(raw).normalized === normalizeContent(raw)`.
 */
export interface NormalizedTextIndex {
  readonly normalized: string;
  /** Raw offset where the raw text behind each normalized unit starts. Non-decreasing. */
  readonly rawStarts: readonly number[];
  /** Raw offset (exclusive) where the raw text behind each normalized unit ends. */
  readonly rawEnds: readonly number[];
}

interface RawCodePoint {
  value: string;
  rawIndex: number;
}

interface IndexBuilder {
  chars: string[];
  rawStarts: number[];
  rawEnds: number[];
}

function push(builder: IndexBuilder, unit: string, rawStart: number, rawEnd: number): void {
  builder.chars.push(unit);
  builder.rawStarts.push(rawStart);
  builder.rawEnds.push(rawEnd);
}

/**
 * Normalize one whitespace-free run of raw code points (NFC, zero-width
 * removal, typographic replacement), attributing each output code point to the
 * raw code points it came from.
 */
function appendNormalizedSegment(rawCodePoints: RawCodePoint[], builder: IndexBuilder): void {
  const last = rawCodePoints[rawCodePoints.length - 1];
  if (last === undefined) return;
  const segmentRawEnd = last.rawIndex + last.value.length;
  const rawLengthAt = new Map(rawCodePoints.map((cp) => [cp.rawIndex, cp.value.length]));

  const nfcCodePoints = Array.from(
    rawCodePoints
      .map((cp) => cp.value)
      .join("")
      .normalize("NFC"),
  );

  // Align NFC output with the raw input through their shared NFD tokens; NFC
  // only composes/decomposes, so the token sequences agree unless the raw text
  // contains singleton decompositions, in which case fall back positionally.
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
    nfcNfdTokens.push(...Array.from(codePoint.normalize("NFD")));
  }
  const tokensAligned =
    rawNfdTokens.length === nfcNfdTokens.length &&
    rawNfdTokens.every((token, index) => token.token === nfcNfdTokens[index]);

  const rawStartOf = (nfcIndex: number): number => {
    if (tokensAligned) {
      const tokenStart = nfcTokenStartByCodePoint[nfcIndex];
      const token = tokenStart === undefined ? undefined : rawNfdTokens[tokenStart];
      if (token === undefined) {
        throw new Error("Normalized token alignment index is out of bounds");
      }
      return token.rawIndex;
    }
    const fallback = rawCodePoints[Math.min(nfcIndex, rawCodePoints.length - 1)];
    if (fallback === undefined) {
      throw new Error("Raw code point mapping is out of bounds");
    }
    return fallback.rawIndex;
  };

  for (const [index, codePoint] of nfcCodePoints.entries()) {
    if (ZERO_WIDTH_CHAR_REGEX.test(codePoint)) continue;
    const rawStart = rawStartOf(index);
    const ownRawEnd = rawStart + (rawLengthAt.get(rawStart) ?? 1);
    const rawEnd =
      index + 1 < nfcCodePoints.length ? Math.max(ownRawEnd, rawStartOf(index + 1)) : segmentRawEnd;
    // Typographic replacements (e.g. curly → straight quotes) keep the
    // index-tracked text identical to normalizeContent() output.
    const replaced = TYPOGRAPHIC_CHAR_MAP.get(codePoint) ?? codePoint;
    for (let unit = 0; unit < replaced.length; unit += 1) {
      push(builder, replaced.charAt(unit), rawStart, rawEnd);
    }
  }
}

export function buildNormalizedTextIndex(rawText: string): NormalizedTextIndex {
  const builder: IndexBuilder = { chars: [], rawStarts: [], rawEnds: [] };
  let pendingWhitespaceStart: number | null = null;
  let segment: RawCodePoint[] = [];

  const flushSegment = (): void => {
    appendNormalizedSegment(segment, builder);
    segment = [];
  };

  for (let rawIndex = 0; rawIndex < rawText.length; ) {
    const codePoint = rawText.codePointAt(rawIndex);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);

    // Zero-width characters are not \s; strip them before whitespace handling
    // so they never cause a pending space to be emitted.
    if (ZERO_WIDTH_CHAR_REGEX.test(char)) {
      rawIndex += char.length;
      continue;
    }

    if (/\s/u.test(char)) {
      flushSegment();
      if (builder.chars.length > 0 && pendingWhitespaceStart === null) {
        pendingWhitespaceStart = rawIndex;
      }
      rawIndex += char.length;
      continue;
    }

    if (pendingWhitespaceStart !== null) {
      // Collapsed whitespace: one space, emitted only between non-space text
      // (so the result is trimmed at both ends).
      push(builder, " ", pendingWhitespaceStart, pendingWhitespaceStart + 1);
      pendingWhitespaceStart = null;
    }

    segment.push({ value: char, rawIndex });
    rawIndex += char.length;
  }
  flushSegment();

  return {
    normalized: builder.chars.join(""),
    rawStarts: builder.rawStarts,
    rawEnds: builder.rawEnds,
  };
}

/** The raw span behind normalized text `[start, end)`, or null for an empty or out-of-range span. */
export function rawSpanOf(
  index: NormalizedTextIndex,
  start: number,
  end: number,
): { rawStart: number; rawEnd: number } | null {
  if (end <= start) return null;
  const rawStart = index.rawStarts[start];
  const rawEnd = index.rawEnds[end - 1];
  if (rawStart === undefined || rawEnd === undefined) return null;
  return { rawStart, rawEnd };
}

/**
 * Length of `normalizeContent(rawText.slice(0, rawOffset))`, read off the
 * index: the normalized units produced before `rawOffset`, minus a trailing
 * collapsed space (which a prefix would trim).
 */
export function normalizedLengthBefore(index: NormalizedTextIndex, rawOffset: number): number {
  let low = 0;
  let high = index.rawStarts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const rawStart = index.rawStarts[middle];
    if (rawStart !== undefined && rawStart < rawOffset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low > 0 && index.normalized.charAt(low - 1) === " " ? low - 1 : low;
}
