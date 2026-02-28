import assert from "node:assert/strict";
import { test } from "node:test";
import { openAiInvestigatorInternals } from "../../src/lib/investigators/openai.js";
import type { InvestigatorImageOccurrence } from "../../src/lib/investigators/interface.js";

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

test("buildInitialInput interleaves text and image occurrences with duplicate/missing markers", () => {
  const contentText = "Alpha Beta Gamma";
  const userPrompt = `prefix section\n${contentText}\nsuffix section`;

  const imageOccurrences: InvestigatorImageOccurrence[] = [
    {
      originalIndex: 0,
      normalizedTextOffset: 6,
      sourceUrl: "https://example.com/a.png",
      resolution: "resolved",
      imageDataUri: "data:image/png;base64,AAA",
      contentHash: "hash-a",
      captionText: "figure-a",
    },
    {
      originalIndex: 1,
      normalizedTextOffset: 11,
      sourceUrl: "https://example.com/b.png",
      resolution: "resolved",
      imageDataUri: "data:image/png;base64,BBB",
      contentHash: "hash-a",
    },
    {
      originalIndex: 2,
      normalizedTextOffset: 16,
      sourceUrl: "https://example.com/c.png",
      resolution: "missing",
    },
    {
      originalIndex: 3,
      normalizedTextOffset: 16,
      sourceUrl: "https://example.com/d.png",
      resolution: "omitted",
    },
  ];

  const input = openAiInvestigatorInternals.buildInitialInput(
    userPrompt,
    contentText,
    imageOccurrences,
  );

  assert.ok(Array.isArray(input));
  const [message] = input;
  assert.ok(isUserInputMessage(message));

  const imageParts = message.content.filter(
    (part): part is InputImagePart => part.type === "input_image",
  );
  assert.equal(imageParts.length, 1);

  const textPayload = message.content
    .filter((part): part is InputTextPart => part.type === "input_text")
    .map((part) => part.text)
    .join("\n");

  assert.match(textPayload, /\[Image context\] figure-a/);
  assert.match(textPayload, /\[Same image as earlier appears here\.\]/);
  assert.match(textPayload, /\[Image present in source but unavailable at inference time\.\]/);
  assert.match(textPayload, /\[Image present in source but omitted due to image budget\.\]/);
  assert.match(textPayload, /\[Note\] 1 image occurrence\(s\) were omitted due to image budget\./);
});

test("buildValidationImageContextNotes describes resolved duplicates distinctly", () => {
  const notes = openAiInvestigatorInternals.buildValidationImageContextNotes([
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
      contentHash: "hash-a",
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
  assert.match(notes, /status=resolved_first/);
  assert.match(notes, /status=resolved_duplicate/);
  assert.match(notes, /status=omitted/);
  assert.match(notes, /caption="caption-a"/);
});
