import { prisma } from "$lib/db/client";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import {
  INVESTIGATION_SYSTEM_PROMPT,
  INVESTIGATION_PROMPT_VERSION,
} from "$lib/investigators/prompt.js";
import { hashContent } from "@openerrata/shared";

let cachedPromptId: Promise<{ id: string }> | null = null;

/**
 * Get or create the current Prompt row.
 *
 * The prompt text and version are compile-time constants, so the result is
 * cached for the lifetime of the process. Concurrent callers share the same
 * in-flight promise. Failures clear the cache so subsequent calls retry.
 */
export function getOrCreateCurrentPrompt(): Promise<{ id: string }> {
  cachedPromptId ??= resolveCurrentPrompt().catch((error: unknown) => {
    cachedPromptId = null;
    throw error;
  });
  return cachedPromptId;
}

/**
 * Resolves the Prompt row for the current prompt text, creating it if needed.
 *
 * Uses hash-based dedup: if the prompt text hasn't changed, the existing row
 * is reused. The find-then-create-with-retry pattern handles races between
 * concurrent processes (e.g. multiple server instances starting up).
 */
async function resolveCurrentPrompt(): Promise<{ id: string }> {
  const text = INVESTIGATION_SYSTEM_PROMPT;
  const hash = await hashContent(text);
  const version = INVESTIGATION_PROMPT_VERSION;

  // Fast path: identical prompt text already exists.
  const byHash = await prisma.prompt.findUnique({
    where: { hash },
    select: { id: true },
  });
  if (byHash) return byHash;

  try {
    return await prisma.prompt.create({
      data: { version, hash, text },
      select: { id: true },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }

  // Another process created the row concurrently — look it up.
  const byHashAfterRace = await prisma.prompt.findUnique({
    where: { hash },
    select: { id: true },
  });
  if (byHashAfterRace) return byHashAfterRace;

  // Unique constraint was on the version column, not the hash. This means
  // the prompt text changed without bumping INVESTIGATION_PROMPT_VERSION.
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
    return { id: byVersion.id };
  }

  throw new Error(
    `Failed to create prompt for version=${version} hash=${hash} and could not load an existing row`,
  );
}
