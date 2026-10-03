import { getPrisma, type PrismaClient } from "$lib/db/client";
import { MINIMUM_SUPPORTED_EXTENSION_VERSION } from "$lib/config/env.js";
import { hashContent, trimToOptionalNonEmpty } from "@openerrata/shared";
import { deriveIpRangePrefix } from "$lib/network/ip.js";
import { findActiveInstanceApiKeyHash } from "$lib/services/instance-api-key.js";
import { deriveRequestIdentity } from "$lib/services/request-identity.js";

export interface RequestEventLike {
  request: Request;
  /**
   * The client's IP address. Behind the chart's ingress this comes from the
   * proxy header named by ADDRESS_HEADER (see startup checks), not the socket.
   */
  getClientAddress: () => string;
}

export interface Context {
  event: RequestEventLike;
  prisma: PrismaClient;
  viewerKey: string;
  ipRangeKey: string;
  isAuthenticated: boolean;
  /** Request-scoped user OpenAI key as sent (`x-openai-api-key`); not yet verified. */
  userOpenAiApiKey: string | null;
  extensionVersion: string | null;
  minimumSupportedExtensionVersion: string;
}

export async function createContext(event: RequestEventLike): Promise<Context> {
  const prisma = getPrisma();
  const identity = await deriveRequestIdentity(
    {
      clientAddress: event.getClientAddress(),
      userAgent: event.request.headers.get("user-agent") ?? "",
      instanceApiKey: event.request.headers.get("x-api-key"),
      userOpenAiApiKey: event.request.headers.get("x-openai-api-key"),
    },
    {
      hashContent,
      deriveIpRangePrefix,
      findActiveInstanceApiKeyHash: async (apiKey) => findActiveInstanceApiKeyHash(prisma, apiKey),
    },
  );

  return {
    event,
    prisma,
    viewerKey: identity.viewerKey,
    ipRangeKey: identity.ipRangeKey,
    isAuthenticated: identity.isAuthenticated,
    userOpenAiApiKey: identity.userOpenAiApiKey,
    extensionVersion:
      trimToOptionalNonEmpty(event.request.headers.get("x-openerrata-extension-version")) ?? null,
    minimumSupportedExtensionVersion: MINIMUM_SUPPORTED_EXTENSION_VERSION,
  };
}
