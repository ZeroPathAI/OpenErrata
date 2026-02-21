import { prisma } from "$lib/db/client";
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

  // Upsert by hash — if the text is identical, reuse
  const prompt = await prisma.prompt.upsert({
    where: { hash },
    create: { version, hash, text },
    update: {}, // No update needed — same hash means same text
    select: { id: true },
  });

  return prompt;
}
