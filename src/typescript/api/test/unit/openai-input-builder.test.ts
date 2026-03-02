import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildInitialInput,
  buildValidationImageContextNotes,
} from "../../src/lib/investigators/openai-input-builder.js";
import type {
  InvestigatorImageOccurrence,
  ImagePlaceholder,
} from "../../src/lib/investigators/interface.js";

interface InputTextPart {
  type: "input_text";
  text: string;
}

interface InputImagePart {
  type: "input_image";
  detail: "auto";
  image_url: string;
}

interface UserInputMessage {
  role: "user";
  content: (InputTextPart | InputImagePart)[];
}

function isUserInputMessage(value: unknown): value is UserInputMessage {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;
  if (record["role"] !== "user") return false;

  const content = record["content"];
  if (!Array.isArray(content)) return false;
  for (const entry of content) {
    if (typeof entry !== "object" || entry === null) return false;

    const part = entry as Record<string, unknown>;

    if (part["type"] === "input_text") {
      if (typeof part["text"] !== "string") return false;
      continue;
    }

    if (part["type"] === "input_image") {
      if (typeof part["image_url"] !== "string") return false;
      continue;
    }

    return false;
  }

  return true;
}

test("buildInitialInput interleaves images at [IMAGE:N] placeholders with duplicate/missing markers", () => {
  const contentString = "Alpha [IMAGE:0] Beta [IMAGE:1] Gamma [IMAGE:2] Delta [IMAGE:3] ";
  const userPrompt = `prefix section\n${contentString}\nsuffix section`;

  const imagePlaceholders: ImagePlaceholder[] = [
    { index: 0, sourceUrl: "https://example.com/a.png" },
    { index: 1, sourceUrl: "https://example.com/a.png" }, // duplicate URL
    { index: 2, sourceUrl: "https://example.com/c.png" },
    { index: 3, sourceUrl: "https://example.com/d.png" },
  ];

  const imageOccurrences: InvestigatorImageOccurrence[] = [
    {
      originalIndex: 0,
      normalizedTextOffset: 6,
      sourceUrl: "https://example.com/a.png",
      resolution: "resolved",
      imageDataUri: "data:image/png;base64,AAA",
      contentHash: "hash-a",
    },
    {
      originalIndex: 1,
      normalizedTextOffset: 11,
      sourceUrl: "https://example.com/c.png",
      resolution: "missing",
    },
    {
      originalIndex: 2,
      normalizedTextOffset: 16,
      sourceUrl: "https://example.com/d.png",
      resolution: "omitted",
    },
  ];

  const contentOffset = userPrompt.indexOf(contentString);
  const input = buildInitialInput(
    userPrompt,
    contentString,
    contentOffset,
    imageOccurrences,
    imagePlaceholders,
  );

  assert.ok(Array.isArray(input));
  const [message] = input;
  assert.ok(isUserInputMessage(message));

  const imageParts = message.content.filter(
    (part): part is InputImagePart => part.type === "input_image",
  );
  assert.equal(
    imageParts.length,
    1,
    "Only the first resolved occurrence of a.png should produce an image part",
  );

  const textPayload = message.content
    .filter((part): part is InputTextPart => part.type === "input_text")
    .map((part) => part.text)
    .join("\n");

  assert.match(textPayload, /\[Same image as earlier appears here\.\]/);
  assert.match(textPayload, /\[Image present in source but unavailable at inference time\.\]/);
  assert.match(textPayload, /\[Image present in source but omitted due to image budget\.\]/);
  assert.match(textPayload, /\[Note\] 1 image occurrence\(s\) were omitted due to image budget\./);
});

test("buildInitialInput falls back to text-offset interleaving when placeholders are unavailable", () => {
  const contentString = "Alpha Beta Gamma Delta";
  const userPrompt = `prefix section\n${contentString}\nsuffix section`;

  const imageOccurrences: InvestigatorImageOccurrence[] = [
    {
      originalIndex: 0,
      normalizedTextOffset: 6,
      sourceUrl: "https://example.com/a.png",
      captionText: "caption-a",
      resolution: "resolved",
      imageDataUri: "data:image/png;base64,AAA",
      contentHash: "hash-shared",
    },
    {
      originalIndex: 1,
      normalizedTextOffset: 11,
      sourceUrl: "https://example.com/b.png",
      resolution: "resolved",
      imageDataUri: "data:image/png;base64,BBB",
      contentHash: "hash-shared",
    },
    {
      originalIndex: 2,
      normalizedTextOffset: 17,
      sourceUrl: "https://example.com/c.png",
      resolution: "missing",
    },
  ];

  const contentOffset = userPrompt.indexOf(contentString);
  const input = buildInitialInput(
    userPrompt,
    contentString,
    contentOffset,
    imageOccurrences,
    undefined,
  );

  assert.ok(Array.isArray(input));
  const [message] = input;
  assert.ok(isUserInputMessage(message));

  const imageParts = message.content.filter(
    (part): part is InputImagePart => part.type === "input_image",
  );
  assert.equal(imageParts.length, 1, "Duplicate resolved content hashes should be de-duplicated");

  const textPayload = message.content
    .filter((part): part is InputTextPart => part.type === "input_text")
    .map((part) => part.text)
    .join("\n");

  assert.match(textPayload, /\[Image context\] caption-a/);
  assert.match(textPayload, /\[Same image as earlier appears here\.\]/);
  assert.match(textPayload, /\[Image present in source but unavailable at inference time\.\]/);
});

test("buildInitialInput yields equivalent multimodal payload on retry placeholder reconstruction", () => {
  const contentString = "Alpha [IMAGE:0] Beta [IMAGE:1] Gamma [IMAGE:2] Delta";
  const userPrompt = `prefix section\n${contentString}\nsuffix section`;

  const firstAttemptPlaceholders: ImagePlaceholder[] = [
    { index: 0, sourceUrl: "https://example.com/a.png" },
    { index: 1, sourceUrl: "https://example.com/b.png" },
    { index: 2, sourceUrl: "https://example.com/c.png" },
  ];

  // Retry path placeholders reconstructed from markdown have no recoverable URL.
  const retryPlaceholders: ImagePlaceholder[] = [
    { index: 0, sourceUrl: "" },
    { index: 1, sourceUrl: "" },
    { index: 2, sourceUrl: "" },
  ];

  const imageOccurrences: InvestigatorImageOccurrence[] = [
    {
      originalIndex: 0,
      normalizedTextOffset: 6,
      sourceUrl: "https://example.com/a.png",
      resolution: "resolved",
      imageDataUri: "data:image/png;base64,AAA",
      contentHash: "hash-a",
    },
    {
      originalIndex: 1,
      normalizedTextOffset: 22,
      sourceUrl: "https://example.com/b.png",
      resolution: "missing",
    },
    {
      originalIndex: 2,
      normalizedTextOffset: 39,
      sourceUrl: "https://example.com/c.png",
      resolution: "resolved",
      imageDataUri: "data:image/png;base64,CCC",
      contentHash: "hash-c",
    },
  ];

  const contentOffset = userPrompt.indexOf(contentString);
  const firstAttemptInput = buildInitialInput(
    userPrompt,
    contentString,
    contentOffset,
    imageOccurrences,
    firstAttemptPlaceholders,
  );
  const retryInput = buildInitialInput(
    userPrompt,
    contentString,
    contentOffset,
    imageOccurrences,
    retryPlaceholders,
  );

  assert.deepEqual(
    retryInput,
    firstAttemptInput,
    "Retry reconstruction should preserve semantic multimodal input",
  );
});

test("buildValidationImageContextNotes describes resolved duplicates distinctly", () => {
  const notes = buildValidationImageContextNotes([
    {
      originalIndex: 0,
      normalizedTextOffset: 2,
      sourceUrl: "https://example.com/a.png",
      resolution: "resolved",
      imageDataUri: "data:image/png;base64,AAA",
      contentHash: "hash-a",
      captionText: "caption-a",
    },
    {
      originalIndex: 1,
      normalizedTextOffset: 5,
      sourceUrl: "https://example.com/b.png",
      resolution: "resolved",
      imageDataUri: "data:image/png;base64,BBB",
      contentHash: "hash-a", // same content hash → duplicate
    },
    {
      originalIndex: 2,
      normalizedTextOffset: 9,
      sourceUrl: "https://example.com/c.png",
      resolution: "omitted",
    },
  ]);

  assert.notEqual(notes, undefined);
  if (notes === undefined) throw new Error("expected notes");

  // One line per occurrence
  const lines = notes.split("\n");
  assert.equal(lines.length, 3);

  const [firstLine, duplicateLine, omittedLine] = lines as [string, string, string];

  // First resolved occurrence and its duplicate (same contentHash) must be described differently
  assert.notEqual(firstLine, duplicateLine);

  // Caption text for the first occurrence must be conveyed to the validator
  assert.match(firstLine, /caption-a/);

  // Omitted occurrence must be described differently from the resolved ones
  assert.notEqual(omittedLine, firstLine);
  assert.notEqual(omittedLine, duplicateLine);
});
