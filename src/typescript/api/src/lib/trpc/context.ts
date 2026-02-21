import type { RequestEvent } from "@sveltejs/kit";
import { prisma } from "$lib/db/client";
import { getConfiguredApiKeys } from "$lib/config/env.js";
import { hashContent } from "@openerrata/shared";
import { verifyHmac } from "$lib/services/hmac.js";
import { deriveIpRangePrefix } from "$lib/network/ip.js";

export type Context = {
  event: RequestEvent;
  prisma: typeof prisma;
  viewerKey: string;
  ipRangeKey: string;
  isAuthenticated: boolean;
  canInvestigate: boolean;
  userOpenAiApiKey: string | null;
  hasValidAttestation: boolean;
};

export async function createContext(event: RequestEvent): Promise<Context> {
  const authenticatedApiKey = getAuthenticatedApiKey(event);
  const userOpenAiApiKey = getUserOpenAiApiKey(event);
  const viewerKey = await deriveViewerKey(event, authenticatedApiKey);
  const ipRangeKey = await deriveIpRangeKey(event);
  const isAuthenticated = authenticatedApiKey !== null;
  const canInvestigate = isAuthenticated || userOpenAiApiKey !== null;
  const hasValidAttestation = await verifyRequestAttestation(event);

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

function getAuthenticatedApiKey(event: RequestEvent): string | null {
  const apiKey = event.request.headers.get("x-api-key")?.trim();
  if (!apiKey) return null;

  const configured = getConfiguredApiKeys();
  if (configured.length === 0) return null;

  return configured.includes(apiKey) ? apiKey : null;
}

function getUserOpenAiApiKey(event: RequestEvent): string | null {
  const openAiApiKey = event.request.headers.get("x-openai-api-key")?.trim();
  return openAiApiKey && openAiApiKey.length > 0 ? openAiApiKey : null;
}

async function deriveViewerKey(
  event: RequestEvent,
  authenticatedApiKey: string | null,
): Promise<string> {
  // For authenticated users (API key), the key is derived from the API key.
  // For anonymous users, hash IP + UA as a best-effort identifier.
  if (authenticatedApiKey) {
    return hashContent(`apikey:${authenticatedApiKey}`);
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
