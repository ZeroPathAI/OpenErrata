import type { ResponseInput } from "openai/resources/responses/responses";
import { validateAndSortImageOccurrences } from "@openerrata/shared";
import { InvestigatorStructuredOutputError } from "./openai-errors.js";
import type { InvestigatorImageOccurrence, ImagePlaceholder } from "./interface.js";

type ContentInputPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; detail: "auto"; image_url: string };

function appendTextInputPart(contentParts: ContentInputPart[], text: string): void {
  if (text.length === 0) return;
  contentParts.push({
    type: "input_text",
    text,
  });
}

function requirePromptContentBounds(
  userPrompt: string,
  contentString: string,
  contentOffset: number,
): { contentStart: number; contentEnd: number } {
  const contentStart = contentOffset;
  const contentEnd = contentStart + contentString.length;
  if (
    contentStart < 0 ||
    contentEnd > userPrompt.length ||
    userPrompt.slice(contentStart, contentEnd) !== contentString
  ) {
    throw new InvestigatorStructuredOutputError(
      "contentOffset does not point to contentString within the stage-1 user prompt",
    );
  }
  return { contentStart, contentEnd };
}

function normalizeImageOccurrences(
  imageOccurrences: InvestigatorImageOccurrence[] | undefined,
  contentText?: string,
): InvestigatorImageOccurrence[] {
  return validateAndSortImageOccurrences(imageOccurrences, {
    ...(contentText === undefined ? {} : { contentTextLength: contentText.length }),
    onValidationIssue: (issue): never => {
      switch (issue.code) {
        case "NON_CONTIGUOUS_ORIGINAL_INDEX":
          throw new InvestigatorStructuredOutputError(
            "Image occurrences must use contiguous originalIndex values starting at 0",
          );
        case "OFFSET_EXCEEDS_CONTENT_LENGTH":
          throw new InvestigatorStructuredOutputError(
            "Image occurrence offset exceeds contentText length",
          );
        case "DECREASING_NORMALIZED_TEXT_OFFSET":
          throw new InvestigatorStructuredOutputError(
            "Image occurrences must be non-decreasing by normalizedTextOffset",
          );
      }
    },
  });
}

export function buildValidationImageContextNotes(
  imageOccurrences: InvestigatorImageOccurrence[] | undefined,
): string | undefined {
  const normalizedOccurrences = normalizeImageOccurrences(imageOccurrences);
  if (normalizedOccurrences.length === 0) {
    return undefined;
  }

  const seenResolvedContentHashes = new Set<string>();
  const lines = normalizedOccurrences.map((occurrence, index) => {
    const captionPart =
      occurrence.captionText === undefined
        ? ""
        : `; caption=${JSON.stringify(occurrence.captionText)}`;

    if (occurrence.resolution === "resolved") {
      const status = seenResolvedContentHashes.has(occurrence.contentHash)
        ? "resolved_duplicate"
        : "resolved_first";
      seenResolvedContentHashes.add(occurrence.contentHash);
      return `${(index + 1).toString()}. offset=${occurrence.normalizedTextOffset}; status=${status}; sourceUrl=${occurrence.sourceUrl}${captionPart}`;
    }

    return `${(index + 1).toString()}. offset=${occurrence.normalizedTextOffset}; status=${occurrence.resolution}; sourceUrl=${occurrence.sourceUrl}${captionPart}`;
  });

  return lines.join("\n");
}

function buildInputUsingTextOffsets(input: {
  userPrompt: string;
  contentString: string;
  contentOffset: number;
  normalizedOccurrences: InvestigatorImageOccurrence[];
}): ResponseInput {
  const { contentStart, contentEnd } = requirePromptContentBounds(
    input.userPrompt,
    input.contentString,
    input.contentOffset,
  );

  const contentParts: ContentInputPart[] = [];
  appendTextInputPart(contentParts, input.userPrompt.slice(0, contentStart));

  const seenResolvedContentHashes = new Set<string>();
  let cursor = 0;
  let omittedCount = 0;
  for (const occurrence of input.normalizedOccurrences) {
    appendTextInputPart(
      contentParts,
      input.contentString.slice(cursor, occurrence.normalizedTextOffset),
    );
    cursor = occurrence.normalizedTextOffset;

    if (occurrence.captionText !== undefined) {
      appendTextInputPart(contentParts, `[Image context] ${occurrence.captionText}`);
    }

    if (occurrence.resolution === "resolved") {
      if (seenResolvedContentHashes.has(occurrence.contentHash)) {
        appendTextInputPart(contentParts, "[Same image as earlier appears here.]");
        continue;
      }

      seenResolvedContentHashes.add(occurrence.contentHash);
      contentParts.push({
        type: "input_image",
        detail: "auto",
        image_url: occurrence.imageDataUri,
      });
      continue;
    }

    if (occurrence.resolution === "omitted") {
      omittedCount += 1;
      appendTextInputPart(
        contentParts,
        "[Image present in source but omitted due to image budget.]",
      );
      continue;
    }

    appendTextInputPart(
      contentParts,
      "[Image present in source but unavailable at inference time.]",
    );
  }

  appendTextInputPart(contentParts, input.contentString.slice(cursor));
  if (omittedCount > 0) {
    appendTextInputPart(
      contentParts,
      `[Note] ${omittedCount.toString()} image occurrence(s) were omitted due to image budget.`,
    );
  }
  appendTextInputPart(contentParts, input.userPrompt.slice(contentEnd));

  return [
    {
      role: "user",
      content: contentParts,
    },
  ];
}

/**
 * Find the best matching resolved image occurrence for a placeholder.
 *
 * Primary match: by sourceUrl (first-execution path where placeholders have real URLs).
 * Fallback match: by originalIndex (retry path where placeholders have sourceUrl="" since
 * URLs can't be recovered from stored markdown — matching by position in the image list).
 */
function findResolvedOccurrence(
  placeholder: ImagePlaceholder,
  imageOccurrences: InvestigatorImageOccurrence[],
  consumedUrls: Set<string>,
): InvestigatorImageOccurrence | undefined {
  // Primary: match by sourceUrl when placeholder has a real URL
  if (placeholder.sourceUrl.length > 0) {
    for (const occurrence of imageOccurrences) {
      if (
        occurrence.sourceUrl === placeholder.sourceUrl &&
        !consumedUrls.has(occurrence.sourceUrl)
      ) {
        return occurrence;
      }
    }
    return undefined;
  }

  // Fallback: match by index (retry path)
  return imageOccurrences.find((o) => o.originalIndex === placeholder.index);
}

/**
 * Build multimodal input by splitting content at [IMAGE:N] placeholders
 * and inserting resolved image data URIs at each position.
 *
 * Matching: each placeholder's sourceUrl (from imagePlaceholders) is looked up
 * in the resolved imageOccurrences by sourceUrl.
 */
export function buildInitialInput(
  userPrompt: string,
  contentString: string,
  contentOffset: number,
  imageOccurrences: InvestigatorImageOccurrence[] | undefined,
  imagePlaceholders: ImagePlaceholder[] | undefined,
): string | ResponseInput {
  const shouldUsePlaceholderInterleaving =
    imagePlaceholders !== undefined && imagePlaceholders.length > 0;
  const normalizedOccurrences = normalizeImageOccurrences(
    imageOccurrences,
    shouldUsePlaceholderInterleaving ? undefined : contentString,
  );
  if (normalizedOccurrences.length === 0) {
    return userPrompt;
  }

  // No markdown placeholders available (e.g. markdownSource=NONE): interleave
  // images into the raw content string by text offset so we preserve multimodal
  // context for platforms like X.
  if (!shouldUsePlaceholderInterleaving) {
    return buildInputUsingTextOffsets({
      userPrompt,
      contentString,
      contentOffset,
      normalizedOccurrences,
    });
  }

  const { contentStart, contentEnd } = requirePromptContentBounds(
    userPrompt,
    contentString,
    contentOffset,
  );

  // Track which sourceUrls have been consumed (for duplicate detection)
  const consumedUrls = new Set<string>();
  const seenResolvedContentHashes = new Set<string>();

  // Split content at [IMAGE:N] patterns
  const placeholderPattern = /\[IMAGE:(\d+)\]/g;
  const contentParts: ContentInputPart[] = [];

  // Text before the content section
  appendTextInputPart(contentParts, userPrompt.slice(0, contentStart));

  let cursor = 0;
  let omittedCount = 0;
  let match: RegExpExecArray | null;

  while ((match = placeholderPattern.exec(contentString)) !== null) {
    const placeholderIndex = parseInt(match[1] ?? "0", 10);
    const placeholder = imagePlaceholders.find((p) => p.index === placeholderIndex);

    // Text between last position and this placeholder
    appendTextInputPart(contentParts, contentString.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    if (placeholder === undefined) {
      // Unknown placeholder — keep the text as-is
      appendTextInputPart(contentParts, match[0]);
      continue;
    }

    const occurrence = findResolvedOccurrence(placeholder, normalizedOccurrences, consumedUrls);

    if (occurrence?.resolution === "resolved") {
      if (seenResolvedContentHashes.has(occurrence.contentHash)) {
        appendTextInputPart(contentParts, "[Same image as earlier appears here.]");
        continue;
      }

      seenResolvedContentHashes.add(occurrence.contentHash);
      consumedUrls.add(occurrence.sourceUrl);
      contentParts.push({
        type: "input_image",
        detail: "auto",
        image_url: occurrence.imageDataUri,
      });
      continue;
    }

    if (occurrence?.resolution === "omitted") {
      omittedCount += 1;
      appendTextInputPart(
        contentParts,
        "[Image present in source but omitted due to image budget.]",
      );
      continue;
    }

    // Check if a resolved occurrence for this URL was already consumed (duplicate)
    if (placeholder.sourceUrl.length > 0 && consumedUrls.has(placeholder.sourceUrl)) {
      appendTextInputPart(contentParts, "[Same image as earlier appears here.]");
      continue;
    }

    appendTextInputPart(
      contentParts,
      "[Image present in source but unavailable at inference time.]",
    );
  }

  // Remaining content after last placeholder
  appendTextInputPart(contentParts, contentString.slice(cursor));

  if (omittedCount > 0) {
    appendTextInputPart(
      contentParts,
      `[Note] ${omittedCount.toString()} image occurrence(s) were omitted due to image budget.`,
    );
  }

  // Text after the content section
  appendTextInputPart(contentParts, userPrompt.slice(contentEnd));

  return [
    {
      role: "user",
      content: contentParts,
    },
  ];
}

export function buildTwoStepRequestInputAudit(
  userPrompt: string,
  validationPrompt: string,
): string {
  return `=== Stage 1: Fact-check input ===
${userPrompt}

=== Stage 2: Validation input ===
${validationPrompt}`;
}
