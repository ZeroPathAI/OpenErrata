import { prisma } from "$lib/db/client";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import {
  INVESTIGATION_SYSTEM_PROMPT,
  INVESTIGATION_PROMPT_VERSION,
} from "$lib/investigators/prompt.js";
import { hashContent } from "@openerrata/shared";

/**
 * Get or create the current Prompt row.
 * Uses the hash as a dedup key — if the prompt text hasn't changed,
 * reuses the existing row.
 */
export async function getOrCreateCurrentPrompt(): Promise<{ id: string }> {
  const text = INVESTIGATION_SYSTEM_PROMPT;
  const hash = await hashContent(text);
  const version = INVESTIGATION_PROMPT_VERSION;

  // Fast path: if identical prompt text already exists, always reuse by hash.
  const byHash = await prisma.prompt.findUnique({
    where: { hash },
    select: { id: true },
  });
  if (byHash) return byHash;

  let createError: unknown = null;

  try {
    const prompt = await prisma.prompt.create({
      data: { version, hash, text },
      select: { id: true },
    });
    return prompt;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    createError = error;
  }

  const byHashAfterCreate = await prisma.prompt.findUnique({
    where: { hash },
    select: { id: true },
  });
  if (byHashAfterCreate) return byHashAfterCreate;

  const byVersion = await prisma.prompt.findUnique({
    where: { version },
    select: {
      id: true,
      hash: true,
      text: true,
    },
  });
  if (byVersion) {
    if (byVersion.hash !== hash || byVersion.text !== text) {
      throw new Error(
        `Prompt version ${version} exists with different content. Bump INVESTIGATION_PROMPT_VERSION when prompt text changes.`,
      );
    }

    return {
      id: byVersion.id,
    };
  }

  if (createError) {
    throw createError;
  }
  throw new Error(
    `Failed to create prompt for version=${version} hash=${hash} and could not load an existing row`,
  );
}
