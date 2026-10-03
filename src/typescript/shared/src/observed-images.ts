interface ObservedImageSource {
  originalIndex: number;
  sourceUrl: string;
}

/**
 * The distinct image URLs of a post version, in page order. Image occurrences
 * are the single wire representation of a post's images; this list is always
 * derived from them rather than transmitted separately, so the two can never
 * disagree. An absent occurrence list means no images were observed.
 */
export function observedImageUrlsFromOccurrences(
  occurrences: readonly ObservedImageSource[] | undefined,
): string[] {
  if (occurrences === undefined) {
    return [];
  }
  const inPageOrder = [...occurrences].sort(
    (left, right) => left.originalIndex - right.originalIndex,
  );
  return Array.from(new Set(inPageOrder.map((occurrence) => occurrence.sourceUrl)));
}
