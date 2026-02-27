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
