import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAndSortImageOccurrences } from "../../src/image-occurrence-validation.js";

test("validateAndSortImageOccurrences sorts by originalIndex", () => {
  const result = validateAndSortImageOccurrences(
    [
      { originalIndex: 2, normalizedTextOffset: 10 },
      { originalIndex: 0, normalizedTextOffset: 1 },
      { originalIndex: 1, normalizedTextOffset: 4 },
    ],
    {
      contentTextLength: 12,
      onValidationIssue: (issue): never => {
        throw new Error(issue.code);
      },
    },
  );

  assert.deepEqual(
    result.map((entry) => entry.originalIndex),
    [0, 1, 2],
  );
});

test("validateAndSortImageOccurrences rejects non-contiguous originalIndex", () => {
  assert.throws(
    () =>
      validateAndSortImageOccurrences(
        [
          { originalIndex: 0, normalizedTextOffset: 0 },
          { originalIndex: 2, normalizedTextOffset: 4 },
        ],
        {
          contentTextLength: 8,
          onValidationIssue: (issue): never => {
            throw new Error(issue.code);
          },
        },
      ),
    /NON_CONTIGUOUS_ORIGINAL_INDEX/,
  );
});

test("validateAndSortImageOccurrences rejects offsets past content length", () => {
  assert.throws(
    () =>
      validateAndSortImageOccurrences([{ originalIndex: 0, normalizedTextOffset: 9 }], {
        contentTextLength: 8,
        onValidationIssue: (issue): never => {
          throw new Error(issue.code);
        },
      }),
    /OFFSET_EXCEEDS_CONTENT_LENGTH/,
  );
});

test("validateAndSortImageOccurrences returns empty array for undefined input", () => {
  const result = validateAndSortImageOccurrences(undefined, {
    onValidationIssue: (issue): never => {
      throw new Error(issue.code);
    },
  });
  assert.deepEqual(result, []);
});

test("validateAndSortImageOccurrences returns empty array for empty array input", () => {
  const result = validateAndSortImageOccurrences([], {
    onValidationIssue: (issue): never => {
      throw new Error(issue.code);
    },
  });
  assert.deepEqual(result, []);
});

test("validateAndSortImageOccurrences accepts a single occurrence", () => {
  const result = validateAndSortImageOccurrences([{ originalIndex: 0, normalizedTextOffset: 5 }], {
    contentTextLength: 10,
    onValidationIssue: (issue): never => {
      throw new Error(issue.code);
    },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.originalIndex, 0);
});

test("validateAndSortImageOccurrences accepts equal offsets (non-decreasing)", () => {
  // Two images at the same text offset is valid (e.g., adjacent images)
  const result = validateAndSortImageOccurrences(
    [
      { originalIndex: 0, normalizedTextOffset: 5 },
      { originalIndex: 1, normalizedTextOffset: 5 },
    ],
    {
      contentTextLength: 10,
      onValidationIssue: (issue): never => {
        throw new Error(issue.code);
      },
    },
  );
  assert.equal(result.length, 2);
});

test("validateAndSortImageOccurrences accepts offset exactly at content length boundary", () => {
  // Offset equal to content length is valid (image after all text)
  const result = validateAndSortImageOccurrences([{ originalIndex: 0, normalizedTextOffset: 8 }], {
    contentTextLength: 8,
    onValidationIssue: (issue): never => {
      throw new Error(issue.code);
    },
  });
  assert.equal(result.length, 1);
});

test("validateAndSortImageOccurrences rejects duplicate originalIndex values", () => {
  assert.throws(
    () =>
      validateAndSortImageOccurrences(
        [
          { originalIndex: 0, normalizedTextOffset: 1 },
          { originalIndex: 0, normalizedTextOffset: 2 },
        ],
        {
          contentTextLength: 8,
          onValidationIssue: (issue): never => {
            throw new Error(issue.code);
          },
        },
      ),
    /NON_CONTIGUOUS_ORIGINAL_INDEX/,
  );
});

test("validateAndSortImageOccurrences skips content length check when omitted", () => {
  // When contentTextLength is not provided, offset validation is skipped
  const result = validateAndSortImageOccurrences(
    [{ originalIndex: 0, normalizedTextOffset: 999999 }],
    {
      onValidationIssue: (issue): never => {
        throw new Error(issue.code);
      },
    },
  );
  assert.equal(result.length, 1);
});

test("validateAndSortImageOccurrences rejects decreasing text offsets", () => {
  assert.throws(
    () =>
      validateAndSortImageOccurrences(
        [
          { originalIndex: 0, normalizedTextOffset: 5 },
          { originalIndex: 1, normalizedTextOffset: 4 },
        ],
        {
          contentTextLength: 8,
          onValidationIssue: (issue): never => {
            throw new Error(issue.code);
          },
        },
      ),
    /DECREASING_NORMALIZED_TEXT_OFFSET/,
  );
});
