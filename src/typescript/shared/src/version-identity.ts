import { validateAndSortImageOccurrences } from "./image-occurrence-validation.js";

export interface VersionIdentityImageOccurrence {
  originalIndex: number;
  normalizedTextOffset: number;
  sourceUrl: string;
  captionText?: string | null | undefined;
}

interface CanonicalVersionIdentityImageOccurrence {
  originalIndex: number;
  normalizedTextOffset: number;
  sourceUrl: string;
  captionText?: string;
}

export function canonicalizeVersionIdentityImageOccurrences(
  occurrences: readonly VersionIdentityImageOccurrence[] | undefined,
  options?: { contentTextLength?: number },
): CanonicalVersionIdentityImageOccurrence[] {
  return validateAndSortImageOccurrences(occurrences, {
    ...(options?.contentTextLength === undefined
      ? {}
      : { contentTextLength: options.contentTextLength }),
    onValidationIssue: (issue): never => {
      switch (issue.code) {
        case "NON_CONTIGUOUS_ORIGINAL_INDEX":
          throw new Error(
            "Version identity image occurrences must use contiguous originalIndex values starting at 0",
          );
        case "OFFSET_EXCEEDS_CONTENT_LENGTH":
          throw new Error("Version identity image occurrence offset exceeds content length");
        case "DECREASING_NORMALIZED_TEXT_OFFSET":
          throw new Error(
            "Version identity image occurrences must be non-decreasing by normalizedTextOffset",
          );
      }
    },
  }).map((occurrence) => {
    const trimmedCaption = occurrence.captionText?.trim();
    return {
      originalIndex: occurrence.originalIndex,
      normalizedTextOffset: occurrence.normalizedTextOffset,
      sourceUrl: occurrence.sourceUrl,
      ...(trimmedCaption === undefined || trimmedCaption.length === 0
        ? {}
        : { captionText: trimmedCaption }),
    };
  });
}

export function serializeVersionIdentityImageOccurrences(
  occurrences: readonly VersionIdentityImageOccurrence[] | undefined,
  options?: { contentTextLength?: number },
): string {
  return JSON.stringify(canonicalizeVersionIdentityImageOccurrences(occurrences, options));
}

export function serializeObservedVersionIdentity(input: {
  contentText: string;
  imageOccurrences: readonly VersionIdentityImageOccurrence[] | undefined;
}): string {
  return JSON.stringify({
    contentText: input.contentText,
    imageOccurrences: canonicalizeVersionIdentityImageOccurrences(input.imageOccurrences, {
      contentTextLength: input.contentText.length,
    }),
  });
}

export function serializeVersionHashSeed(contentHash: string, occurrencesHash: string): string {
  return `${contentHash}\n${occurrencesHash}`;
}
