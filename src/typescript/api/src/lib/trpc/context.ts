import type { RequestEvent } from "@sveltejs/kit";
import { getPrisma, type PrismaClient } from "$lib/db/client";
import { hashContent } from "@openerrata/shared";
import { verifyHmac } from "$lib/services/hmac.js";
import { deriveIpRangePrefix } from "$lib/network/ip.js";
import { findActiveInstanceApiKeyHash } from "$lib/services/instance-api-key.js";

export type Context = {
  event: RequestEvent;
  prisma: PrismaClient;
  viewerKey: string;
  ipRangeKey: string;
  isAuthenticated: boolean;
  canInvestigate: boolean;
  userOpenAiApiKey: string | null;
  hasValidAttestation: boolean;
};

export async function createContext(event: RequestEvent): Promise<Context> {
  const authenticatedApiKeyHash = await getAuthenticatedApiKeyHash(event);
  const userOpenAiApiKey = getUserOpenAiApiKey(event);
  const viewerKey = await deriveViewerKey(event, authenticatedApiKeyHash);
  const ipRangeKey = await deriveIpRangeKey(event);
  const isAuthenticated = authenticatedApiKeyHash !== null;
  const canInvestigate = isAuthenticated || userOpenAiApiKey !== null;
  const hasValidAttestation = await verifyRequestAttestation(event);

  const prisma = getPrisma();
  return {
    event,
    prisma,
    viewerKey,
    ipRangeKey,
    isAuthenticated,
    canInvestigate,
    userOpenAiApiKey,
    hasValidAttestation,
  };
}

async function getAuthenticatedApiKeyHash(
  event: RequestEvent,
): Promise<string | null> {
  const apiKey = event.request.headers.get("x-api-key")?.trim();
  if (!apiKey) return null;
  return findActiveInstanceApiKeyHash(getPrisma(), apiKey);
}

function getUserOpenAiApiKey(event: RequestEvent): string | null {
  const openAiApiKey = event.request.headers.get("x-openai-api-key")?.trim();
  return openAiApiKey && openAiApiKey.length > 0 ? openAiApiKey : null;
}

async function deriveViewerKey(
  event: RequestEvent,
  authenticatedApiKeyHash: string | null,
): Promise<string> {
  // For authenticated users, derive from API key hash.
  // For anonymous users, hash IP + UA as a best-effort identifier.
  if (authenticatedApiKeyHash) {
    return hashContent(`apikey:${authenticatedApiKeyHash}`);
  }
  const ip = event.getClientAddress();
  const ua = event.request.headers.get("user-agent") ?? "";
  return hashContent(`anon:${ip}:${ua}`);
}

async function deriveIpRangeKey(event: RequestEvent): Promise<string> {
  const prefix = deriveIpRangePrefix(event.getClientAddress());
  return hashContent(`iprange:${prefix}`);
}

async function verifyRequestAttestation(event: RequestEvent): Promise<boolean> {
  const signature = event.request.headers.get("x-openerrata-signature");
  if (!signature) return false;

  try {
    const body = await event.request.clone().text();
    if (!body) return false;
    return await verifyHmac(body, signature);
  } catch {
    return false;
  }
}
