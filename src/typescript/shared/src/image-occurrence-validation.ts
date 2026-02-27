type IndexedImageOccurrence = {
  originalIndex: number;
  normalizedTextOffset: number;
};

type ImageOccurrenceValidationIssue =
  | {
      code: "NON_CONTIGUOUS_ORIGINAL_INDEX";
      position: number;
      originalIndex: number;
    }
  | {
      code: "OFFSET_EXCEEDS_CONTENT_LENGTH";
      position: number;
      normalizedTextOffset: number;
      contentTextLength: number;
    }
  | {
      code: "DECREASING_NORMALIZED_TEXT_OFFSET";
      position: number;
      previousNormalizedTextOffset: number;
      normalizedTextOffset: number;
    };

/**
 * Canonical ordering + invariant checks for image occurrences.
 * This is shared so request ingestion and investigation prompting cannot drift.
 */
export function validateAndSortImageOccurrences<T extends IndexedImageOccurrence>(
  occurrences: readonly T[] | undefined,
  options: {
    contentTextLength?: number;
    onValidationIssue: (issue: ImageOccurrenceValidationIssue) => never;
  },
): T[] {
  if (!occurrences || occurrences.length === 0) {
    return [];
  }

  const sorted = [...occurrences].sort((left, right) => left.originalIndex - right.originalIndex);

  for (const [position, occurrence] of sorted.entries()) {
    if (occurrence.originalIndex !== position) {
      options.onValidationIssue({
        code: "NON_CONTIGUOUS_ORIGINAL_INDEX",
        position,
        originalIndex: occurrence.originalIndex,
      });
    }

    if (
      options.contentTextLength !== undefined &&
      occurrence.normalizedTextOffset > options.contentTextLength
    ) {
      options.onValidationIssue({
        code: "OFFSET_EXCEEDS_CONTENT_LENGTH",
        position,
        normalizedTextOffset: occurrence.normalizedTextOffset,
        contentTextLength: options.contentTextLength,
      });
    }

    if (position > 0) {
      const previousOccurrence = sorted[position - 1];
      if (previousOccurrence === undefined) {
        throw new Error(
          `image occurrence validation missing previous entry at position ${position.toString()}`,
        );
      }
      if (occurrence.normalizedTextOffset >= previousOccurrence.normalizedTextOffset) {
        continue;
      }

      options.onValidationIssue({
        code: "DECREASING_NORMALIZED_TEXT_OFFSET",
        position,
        previousNormalizedTextOffset: previousOccurrence.normalizedTextOffset,
        normalizedTextOffset: occurrence.normalizedTextOffset,
      });
    }
  }

  return sorted;
}
