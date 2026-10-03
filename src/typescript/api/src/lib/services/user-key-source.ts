/**
 * Request-scoped user OpenAI keys (SPEC §2.2.6, §3.7).
 *
 * A user key funds only an investigation its own request admits. It is
 * verified with OpenAI before it is attached to anything, stored encrypted
 * with a short TTL on InvestigationOpenAiKeySource, and deleted on every
 * terminal transition — or as soon as it turns out to be unusable, in which
 * case the investigation becomes unfunded rather than FAILED.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { DbClient } from "$lib/db/client";
import type { InvestigationOrigin, Prisma } from "$lib/db/prisma-client";
import { getDatabaseEncryptionConfig } from "$lib/config/env.js";
import type { OpenAiKeyValidationStatusOutcome } from "./openai-key-validation-core.js";
import { validateOpenAiApiKeyForSettings } from "./openai-key-validation.js";

const OPENAI_KEY_SOURCE_TTL_MS = 30 * 60 * 1000;
const AES_GCM_IV_BYTES = 12;

interface EncryptionConfig {
  keyId: string;
  keyBytes: Buffer;
}

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

declare const verifiedOpenAiApiKeyBrand: unique symbol;

/** A user OpenAI key that OpenAI accepted moments ago. Only `verifyUserOpenAiApiKey` makes one. */
export type VerifiedOpenAiApiKey = string & { readonly [verifiedOpenAiApiKeyBrand]: true };

export type UserOpenAiKeyVerification =
  | { verified: true; apiKey: VerifiedOpenAiApiKey }
  | {
      verified: false;
      outcome: Exclude<OpenAiKeyValidationStatusOutcome, { openaiApiKeyStatus: "valid" }>;
    };

/** Ask OpenAI whether `apiKey` works before letting it fund anything. */
export async function verifyUserOpenAiApiKey(apiKey: string): Promise<UserOpenAiKeyVerification> {
  const outcome = await validateOpenAiApiKeyForSettings(apiKey);
  if (outcome.openaiApiKeyStatus !== "valid") {
    return { verified: false, outcome };
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded only after OpenAI accepted the key above
  return { verified: true, apiKey: apiKey as VerifiedOpenAiApiKey };
}

/** Store `apiKey` (encrypted, short-lived) as the funding source of `investigationId`. */
export async function attachOpenAiKeySource(
  tx: Prisma.TransactionClient,
  input: { investigationId: string; apiKey: VerifiedOpenAiApiKey; now: Date },
): Promise<void> {
  const encrypted = encryptOpenAiKey(input.apiKey);
  await tx.investigationOpenAiKeySource.create({
    data: {
      investigationId: input.investigationId,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      keyId: encrypted.keyId,
      expiresAt: new Date(input.now.getTime() + OPENAI_KEY_SOURCE_TTL_MS),
    },
  });
}

export type InvestigationKeyResolution =
  | { type: "SERVER_KEY" }
  | { type: "USER_OPENAI_KEY"; apiKey: string };

export class ExpiredOpenAiKeySourceError extends Error {
  constructor(investigationId: string) {
    super(`Investigation ${investigationId} user-provided OpenAI key expired before worker start`);
    this.name = "ExpiredOpenAiKeySourceError";
  }
}

export class InvalidOpenAiKeySourceError extends Error {
  constructor(investigationId: string, reason: string) {
    super(`Investigation ${investigationId} user-provided OpenAI key invalid: ${reason}`);
    this.name = "InvalidOpenAiKeySourceError";
  }
}

/**
 * The key a worker must use for `investigation`: the server key for SELECTOR
 * and INSTANCE_REQUEST admissions, the attached user key for USER_KEY_REQUEST.
 * A user-key investigation never falls back to the server key — a missing,
 * expired or undecryptable key source throws, and the caller drops the key.
 */
export async function resolveInvestigationKey(
  db: DbClient,
  investigation: { id: string; origin: InvestigationOrigin },
): Promise<InvestigationKeyResolution> {
  if (investigation.origin !== "USER_KEY_REQUEST") {
    return { type: "SERVER_KEY" };
  }

  const keySource = await db.investigationOpenAiKeySource.findUnique({
    where: { investigationId: investigation.id },
    select: {
      keyId: true,
      ciphertext: true,
      iv: true,
      authTag: true,
      expiresAt: true,
    },
  });
  if (keySource === null) {
    throw new InvalidOpenAiKeySourceError(investigation.id, "no key source is attached");
  }

  if (keySource.expiresAt.getTime() <= Date.now()) {
    throw new ExpiredOpenAiKeySourceError(investigation.id);
  }

  let apiKey: string;
  try {
    apiKey = decryptOpenAiKey(keySource);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new InvalidOpenAiKeySourceError(investigation.id, reason);
  }
  if (apiKey.trim().length === 0) {
    throw new InvalidOpenAiKeySourceError(investigation.id, "decrypted key was empty");
  }
  return { type: "USER_OPENAI_KEY", apiKey };
}

export async function consumeOpenAiKeySource(
  tx: Prisma.TransactionClient,
  investigationId: string,
): Promise<void> {
  await tx.investigationOpenAiKeySource.deleteMany({
    where: { investigationId },
  });
}
