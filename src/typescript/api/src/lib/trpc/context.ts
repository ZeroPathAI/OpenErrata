import type { RequestEvent } from "@sveltejs/kit";
import { getPrisma, type PrismaClient } from "$lib/db/client";
import { hashContent } from "@openerrata/shared";
import { verifyHmac } from "$lib/services/hmac.js";
import { deriveIpRangePrefix } from "$lib/network/ip.js";
import { findActiveInstanceApiKeyHash } from "$lib/services/instance-api-key.js";
import { deriveRequestIdentity } from "$lib/services/request-identity.js";

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
  const prisma = getPrisma();
  const identity = await deriveRequestIdentity(
    {
      clientAddress: event.getClientAddress(),
      userAgent: event.request.headers.get("user-agent") ?? "",
      instanceApiKey: event.request.headers.get("x-api-key"),
      userOpenAiApiKey: event.request.headers.get("x-openai-api-key"),
      attestationSignature: event.request.headers.get("x-openerrata-signature"),
      attestationBody: await readRequestBody(event),
    },
    {
      hashContent,
      deriveIpRangePrefix,
      verifyHmac,
      findActiveInstanceApiKeyHash: async (apiKey) => findActiveInstanceApiKeyHash(prisma, apiKey),
    },
  );

  return {
    event,
    prisma,
    viewerKey: identity.viewerKey,
    ipRangeKey: identity.ipRangeKey,
    isAuthenticated: identity.isAuthenticated,
    canInvestigate: identity.canInvestigate,
    userOpenAiApiKey: identity.userOpenAiApiKey,
    hasValidAttestation: identity.hasValidAttestation,
  };
}

async function readRequestBody(event: RequestEvent): Promise<string | null> {
  try {
    return await event.request.clone().text();
  } catch {
    return null;
  }
}
