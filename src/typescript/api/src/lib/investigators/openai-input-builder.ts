import type { ResponseInput } from "openai/resources/responses/responses";
import { validateAndSortImageOccurrences } from "@openerrata/shared";
import { InvestigatorStructuredOutputError } from "./openai.js";
import type { InvestigatorImageOccurrence } from "./interface.js";

export type ContentInputPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; detail: "auto"; image_url: string };

export function appendTextInputPart(contentParts: ContentInputPart[], text: string): void {
  if (text.length === 0) return;
  contentParts.push({
    type: "input_text",
    text,
  });
}

export function normalizeImageOccurrences(
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

export function buildInitialInput(
  userPrompt: string,
  contentText: string,
  imageOccurrences: InvestigatorImageOccurrence[] | undefined,
): string | ResponseInput {
  const normalizedOccurrences = normalizeImageOccurrences(imageOccurrences, contentText);
  if (normalizedOccurrences.length === 0) {
    return userPrompt;
  }

  const postTextStart = userPrompt.indexOf(contentText);
  const postTextEnd = postTextStart + contentText.length;
  if (postTextStart < 0) {
    throw new InvestigatorStructuredOutputError(
      "Post contentText was not found in the stage-1 user prompt",
    );
  }
  if (userPrompt.lastIndexOf(contentText) !== postTextStart) {
    throw new InvestigatorStructuredOutputError(
      "Post contentText appeared multiple times in the stage-1 user prompt",
    );
  }

  const contentParts: ContentInputPart[] = [];
  appendTextInputPart(contentParts, userPrompt.slice(0, postTextStart));

  const seenResolvedContentHashes = new Set<string>();
  let cursor = 0;
  let omittedCount = 0;
  for (const occurrence of normalizedOccurrences) {
    appendTextInputPart(contentParts, contentText.slice(cursor, occurrence.normalizedTextOffset));
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

  appendTextInputPart(contentParts, contentText.slice(cursor));
  if (omittedCount > 0) {
    appendTextInputPart(
      contentParts,
      `[Note] ${omittedCount.toString()} image occurrence(s) were omitted due to image budget.`,
    );
  }
  appendTextInputPart(contentParts, userPrompt.slice(postTextEnd));

  const multimodalInput: ResponseInput = [
    {
      role: "user",
      content: contentParts,
    },
  ];

  return multimodalInput;
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
