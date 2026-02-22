import { createHash } from "node:crypto";
import type { PrismaClient } from "$lib/generated/prisma/client";

function normalizeInstanceApiKey(input: string): string {
  return input.trim();
}

export function hashInstanceApiKey(apiKey: string): string {
  const normalized = normalizeInstanceApiKey(apiKey);
  if (normalized.length === 0) {
    throw new Error("Instance API key must be non-empty");
  }

  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export async function findActiveInstanceApiKeyHash(
  prisma: PrismaClient,
  apiKey: string,
): Promise<string | null> {
  const normalized = normalizeInstanceApiKey(apiKey);
  if (normalized.length === 0) {
    return null;
  }

  const keyHash = hashInstanceApiKey(normalized);
  const key = await prisma.instanceApiKey.findUnique({
    where: { keyHash },
    select: { revokedAt: true },
  });

  if (!key || key.revokedAt !== null) {
    return null;
  }
  return keyHash;
}
