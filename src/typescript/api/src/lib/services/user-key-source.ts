import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import type { Prisma, PrismaClient } from "$lib/generated/prisma/client";
import { getDatabaseEncryptionConfig } from "$lib/config/env.js";

const OPENAI_KEY_SOURCE_TTL_MS = 30 * 60 * 1000;
const AES_GCM_IV_BYTES = 12;

type EncryptionConfig = {
  keyId: string;
  keyBytes: Buffer;
};

let cachedEncryptionConfig: EncryptionConfig | null = null;

function getEncryptionConfig(): EncryptionConfig {
  if (cachedEncryptionConfig) return cachedEncryptionConfig;

  const { keyMaterial, keyId } = getDatabaseEncryptionConfig();
  const keyBytes = createHash("sha256").update(keyMaterial, "utf8").digest();
  cachedEncryptionConfig = { keyId, keyBytes };
  return cachedEncryptionConfig;
}

function encryptOpenAiKey(apiKey: string): {
  keyId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
} {
  const { keyId, keyBytes } = getEncryptionConfig();
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBytes, iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    keyId,
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

function decryptOpenAiKey(input: {
  keyId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
}): string {
  const { keyId, keyBytes } = getEncryptionConfig();
  if (input.keyId !== keyId) {
    throw new Error(
      `Investigation OpenAI key source keyId mismatch (stored=${input.keyId}, active=${keyId})`,
    );
  }

  const decipher = createDecipheriv("aes-256-gcm", keyBytes, Buffer.from(input.iv, "base64"));
  decipher.setAuthTag(Buffer.from(input.authTag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(input.ciphertext, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

type AttachOpenAiKeySourceResult = "ATTACHED" | "ALREADY_ATTACHED" | "NOT_PENDING" | "MISSING_RUN";

export async function attachOpenAiKeySourceIfPendingRun(
  prisma: PrismaClient,
  input: {
    runId: string;
    openAiApiKey: string;
  },
): Promise<AttachOpenAiKeySourceResult> {
  const encrypted = encryptOpenAiKey(input.openAiApiKey);
  const expiresAt = new Date(Date.now() + OPENAI_KEY_SOURCE_TTL_MS);

  try {
    return await prisma.$transaction(async (tx) => {
      const run = await tx.investigationRun.findUnique({
        where: { id: input.runId },
        select: {
          id: true,
          investigation: { select: { status: true } },
        },
      });
      if (!run) return "MISSING_RUN";
      if (run.investigation.status !== "PENDING") return "NOT_PENDING";

      const existing = await tx.investigationOpenAiKeySource.findUnique({
        where: { runId: input.runId },
        select: { runId: true },
      });
      if (existing) return "ALREADY_ATTACHED";

      await tx.investigationOpenAiKeySource.create({
        data: {
          runId: input.runId,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyId: encrypted.keyId,
          expiresAt,
        },
      });
      return "ATTACHED";
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return "ALREADY_ATTACHED";
  }
}

type InvestigationRunKeyResolution =
  | { type: "SERVER_KEY" }
  | { type: "USER_OPENAI_KEY"; apiKey: string };

export class ExpiredOpenAiKeySourceError extends Error {
  constructor(runId: string) {
    super(`Investigation run ${runId} user-provided OpenAI key expired before worker start`);
    this.name = "ExpiredOpenAiKeySourceError";
  }
}

export class InvalidOpenAiKeySourceError extends Error {
  constructor(runId: string, reason: string) {
    super(`Investigation run ${runId} user-provided OpenAI key invalid: ${reason}`);
    this.name = "InvalidOpenAiKeySourceError";
  }
}

export async function resolveInvestigationRunKey(
  prisma: PrismaClient,
  runId: string,
): Promise<InvestigationRunKeyResolution> {
  const keySource = await prisma.investigationOpenAiKeySource.findUnique({
    where: { runId },
    select: {
      keyId: true,
      ciphertext: true,
      iv: true,
      authTag: true,
      expiresAt: true,
    },
  });
  if (!keySource) return { type: "SERVER_KEY" };

  if (keySource.expiresAt.getTime() <= Date.now()) {
    throw new ExpiredOpenAiKeySourceError(runId);
  }

  try {
    const apiKey = decryptOpenAiKey(keySource);
    if (apiKey.trim().length === 0) {
      throw new Error("decrypted key was empty");
    }
    return { type: "USER_OPENAI_KEY", apiKey };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new InvalidOpenAiKeySourceError(runId, reason);
  }
}

export async function consumeOpenAiKeySource(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<void> {
  await tx.investigationOpenAiKeySource.deleteMany({
    where: { runId },
  });
}
