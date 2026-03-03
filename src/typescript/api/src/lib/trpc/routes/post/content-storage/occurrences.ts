import { validateAndSortImageOccurrences, type ViewPostInput } from "@openerrata/shared";
import { TRPCError } from "@trpc/server";
import type { ImageOccurrence, ImageOccurrenceSet } from "$lib/generated/prisma/client";
import { createOrFindByUniqueConstraint, type DbClient } from "./shared.js";
import { imageOccurrencesHash } from "./hashing.js";

export function validateAndNormalizeImageOccurrences(
  occurrences: ViewPostInput["observedImageOccurrences"],
  contentText: string,
): NonNullable<ViewPostInput["observedImageOccurrences"]> {
  const sorted = validateAndSortImageOccurrences(occurrences, {
    contentTextLength: contentText.length,
    onValidationIssue: (issue): never => {
      switch (issue.code) {
        case "NON_CONTIGUOUS_ORIGINAL_INDEX":
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Observed image occurrences must use contiguous originalIndex values starting at 0",
          });
        case "OFFSET_EXCEEDS_CONTENT_LENGTH":
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Observed image occurrence offset exceeds content length",
          });
        case "DECREASING_NORMALIZED_TEXT_OFFSET":
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Observed image occurrences must be non-decreasing by normalizedTextOffset",
          });
      }
    },
  });

  return sorted.map((occurrence) => {
    const captionText = occurrence.captionText?.trim();
    return {
      originalIndex: occurrence.originalIndex,
      normalizedTextOffset: occurrence.normalizedTextOffset,
      sourceUrl: occurrence.sourceUrl,
      ...(captionText === undefined || captionText.length === 0 ? {} : { captionText }),
    };
  });
}

function normalizedOccurrenceToData(
  normalizedOccurrences: NonNullable<ViewPostInput["observedImageOccurrences"]>,
): {
  originalIndex: number;
  normalizedTextOffset: number;
  sourceUrl: string;
  captionText: string | null;
}[] {
  return normalizedOccurrences.map((occurrence) => ({
    originalIndex: occurrence.originalIndex,
    normalizedTextOffset: occurrence.normalizedTextOffset,
    sourceUrl: occurrence.sourceUrl,
    captionText: occurrence.captionText ?? null,
  }));
}

function hasSameNormalizedOccurrences(
  stored: {
    originalIndex: number;
    normalizedTextOffset: number;
    sourceUrl: string;
    captionText: string | null;
  }[],
  normalized: NonNullable<ViewPostInput["observedImageOccurrences"]>,
): boolean {
  if (stored.length !== normalized.length) {
    return false;
  }

  for (let index = 0; index < stored.length; index += 1) {
    const a = stored[index];
    const b = normalized[index];
    if (a === undefined || b === undefined) {
      return false;
    }
    if (
      a.originalIndex !== b.originalIndex ||
      a.normalizedTextOffset !== b.normalizedTextOffset ||
      a.sourceUrl !== b.sourceUrl ||
      a.captionText !== (b.captionText ?? null)
    ) {
      return false;
    }
  }

  return true;
}

async function findImageOccurrenceSetByHash(prisma: DbClient, occurrencesHash: string) {
  return prisma.imageOccurrenceSet.findUnique({
    where: { occurrencesHash },
    include: {
      occurrences: {
        orderBy: [{ originalIndex: "asc" }],
      },
    },
  });
}

async function createImageOccurrenceSet(input: {
  prisma: DbClient;
  occurrencesHash: string;
  normalizedOccurrences: NonNullable<ViewPostInput["observedImageOccurrences"]>;
}) {
  return input.prisma.imageOccurrenceSet.create({
    data: {
      occurrencesHash: input.occurrencesHash,
      ...(input.normalizedOccurrences.length === 0
        ? {}
        : {
            occurrences: {
              create: normalizedOccurrenceToData(input.normalizedOccurrences),
            },
          }),
    },
    include: {
      occurrences: {
        orderBy: [{ originalIndex: "asc" }],
      },
    },
  });
}

function assertOccurrenceSetMatches(input: {
  occurrencesHash: string;
  normalizedOccurrences: NonNullable<ViewPostInput["observedImageOccurrences"]>;
  existing: {
    occurrences: {
      originalIndex: number;
      normalizedTextOffset: number;
      sourceUrl: string;
      captionText: string | null;
    }[];
  };
}): void {
  if (!hasSameNormalizedOccurrences(input.existing.occurrences, input.normalizedOccurrences)) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `image occurrence hash collision for ${input.occurrencesHash}`,
    });
  }
}

export async function getOrCreateImageOccurrenceSet(
  prisma: DbClient,
  normalizedOccurrences: NonNullable<ViewPostInput["observedImageOccurrences"]>,
): Promise<ImageOccurrenceSet & { occurrences: ImageOccurrence[] }> {
  const hash = imageOccurrencesHash(normalizedOccurrences);

  return createOrFindByUniqueConstraint({
    findExisting: () => findImageOccurrenceSetByHash(prisma, hash),
    create: () =>
      createImageOccurrenceSet({
        prisma,
        occurrencesHash: hash,
        normalizedOccurrences,
      }),
    assertEquivalent: (existing) =>
      assertOccurrenceSetMatches({
        occurrencesHash: hash,
        normalizedOccurrences,
        existing,
      }),
  });
}
