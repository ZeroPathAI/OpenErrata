import { TRPCError } from "@trpc/server";
import { wordCount } from "$lib/services/investigation-lifecycle.js";
import type { ContentBlob } from "$lib/db/prisma-client";
import { createOrFindByUniqueConstraint, type DbClient } from "./shared.js";
import { sha256 } from "./hashing.js";

export async function getOrCreateContentBlob(
  prisma: DbClient,
  input: {
    contentHash: string;
    contentText: string;
  },
): Promise<ContentBlob> {
  return createOrFindByUniqueConstraint({
    findExisting: () =>
      prisma.contentBlob.findUnique({
        where: { contentHash: input.contentHash },
      }),
    create: () =>
      prisma.contentBlob.create({
        data: {
          contentHash: input.contentHash,
          contentText: input.contentText,
          wordCount: wordCount(input.contentText),
        },
      }),
    assertEquivalent: (existing) => {
      if (existing.contentText !== input.contentText) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `contentHash collision for ${input.contentHash}`,
        });
      }
    },
  });
}

export async function getOrCreateHtmlBlob(
  prisma: DbClient,
  html: string,
): Promise<{ id: string; htmlHash: string }> {
  const htmlHash = sha256(html);
  return createOrFindByUniqueConstraint({
    findExisting: () =>
      prisma.htmlBlob.findUnique({
        where: { htmlHash },
        select: { id: true, htmlHash: true },
      }),
    create: () =>
      prisma.htmlBlob.create({
        data: { htmlHash, htmlContent: html },
        select: { id: true, htmlHash: true },
      }),
    assertEquivalent: () => {
      // Content-addressed: same hash means same content.
    },
  });
}
