interface RequestIdentityInput {
  clientAddress: string;
  userAgent: string;
  instanceApiKey: string | null | undefined;
  userOpenAiApiKey: string | null | undefined;
}

interface RequestIdentityDependencies {
  hashContent: (value: string) => Promise<string>;
  findActiveInstanceApiKeyHash: (apiKey: string) => Promise<string | null>;
  deriveIpRangePrefix: (ipAddress: string) => string;
}

interface RequestIdentity {
  /** Stable hashed viewer: the instance API key when authenticated, else address + user agent. */
  viewerKey: string;
  /** Stable hashed /24 (IPv4) or /48 (IPv6) of the client address. */
  ipRangeKey: string;
  /** Whether the request carries an active instance API key. */
  isAuthenticated: boolean;
  /** The request-scoped user OpenAI key, as sent; unverified. */
  userOpenAiApiKey: string | null;
}

function trimToOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

export async function deriveRequestIdentity(
  input: RequestIdentityInput,
  dependencies: RequestIdentityDependencies,
): Promise<RequestIdentity> {
  const instanceApiKey = trimToOptional(input.instanceApiKey);
  const authenticatedApiKeyHash =
    instanceApiKey === null
      ? null
      : await dependencies.findActiveInstanceApiKeyHash(instanceApiKey);

  const viewerKey = await dependencies.hashContent(
    authenticatedApiKeyHash === null
      ? `anon:${input.clientAddress}:${input.userAgent}`
      : `apikey:${authenticatedApiKeyHash}`,
  );
  const ipRangePrefix = dependencies.deriveIpRangePrefix(input.clientAddress);
  const ipRangeKey = await dependencies.hashContent(`iprange:${ipRangePrefix}`);

  return {
    viewerKey,
    ipRangeKey,
    isAuthenticated: authenticatedApiKeyHash !== null,
    userOpenAiApiKey: trimToOptional(input.userOpenAiApiKey),
  };
}
