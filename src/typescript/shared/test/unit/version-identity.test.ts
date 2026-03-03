import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalizeVersionIdentityImageOccurrences,
  serializeObservedVersionIdentity,
  serializeVersionHashSeed,
  serializeVersionIdentityImageOccurrences,
} from "../../src/version-identity.js";

test("canonicalizeVersionIdentityImageOccurrences sorts by originalIndex and trims captions", () => {
  const canonical = canonicalizeVersionIdentityImageOccurrences(
    [
      {
        originalIndex: 1,
        normalizedTextOffset: 8,
        sourceUrl: "https://example.com/b.png",
        captionText: "  second image  ",
      },
      {
        originalIndex: 0,
        normalizedTextOffset: 2,
        sourceUrl: "https://example.com/a.png",
      },
    ],
    {
      contentTextLength: 16,
    },
  );

  assert.deepEqual(canonical, [
    {
      originalIndex: 0,
      normalizedTextOffset: 2,
      sourceUrl: "https://example.com/a.png",
    },
    {
      originalIndex: 1,
      normalizedTextOffset: 8,
      sourceUrl: "https://example.com/b.png",
      captionText: "second image",
    },
  ]);
});

test("serializeVersionIdentityImageOccurrences uses canonical ordering", () => {
  const first = serializeVersionIdentityImageOccurrences([
    {
      originalIndex: 1,
      normalizedTextOffset: 8,
      sourceUrl: "https://example.com/b.png",
    },
    {
      originalIndex: 0,
      normalizedTextOffset: 2,
      sourceUrl: "https://example.com/a.png",
    },
  ]);
  const second = serializeVersionIdentityImageOccurrences([
    {
      originalIndex: 0,
      normalizedTextOffset: 2,
      sourceUrl: "https://example.com/a.png",
    },
    {
      originalIndex: 1,
      normalizedTextOffset: 8,
      sourceUrl: "https://example.com/b.png",
    },
  ]);

  assert.equal(first, second);
});

test("serializeObservedVersionIdentity treats undefined and empty occurrences equally", () => {
  const withoutOccurrences = serializeObservedVersionIdentity({
    contentText: "Alpha beta",
    imageOccurrences: undefined,
  });
  const withEmptyOccurrences = serializeObservedVersionIdentity({
    contentText: "Alpha beta",
    imageOccurrences: [],
  });

  assert.equal(withoutOccurrences, withEmptyOccurrences);
});

test("serializeObservedVersionIdentity validates offsets against content length", () => {
  assert.throws(
    () =>
      serializeObservedVersionIdentity({
        contentText: "short",
        imageOccurrences: [
          {
            originalIndex: 0,
            normalizedTextOffset: 9,
            sourceUrl: "https://example.com/a.png",
          },
        ],
      }),
    /offset exceeds content length/i,
  );
});

test("serializeVersionHashSeed composes stable preimage", () => {
  assert.equal(
    serializeVersionHashSeed("content-hash", "occurrence-hash"),
    "content-hash\noccurrence-hash",
  );
});
