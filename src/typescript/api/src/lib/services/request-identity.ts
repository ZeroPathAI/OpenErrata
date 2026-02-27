type RequestIdentityInput = {
  clientAddress: string;
  userAgent: string;
  instanceApiKey: string | null | undefined;
  userOpenAiApiKey: string | null | undefined;
  attestationSignature: string | null | undefined;
  attestationBody: string | null;
};

type RequestIdentityDependencies = {
  hashContent: (value: string) => Promise<string>;
  findActiveInstanceApiKeyHash: (apiKey: string) => Promise<string | null>;
  deriveIpRangePrefix: (ipAddress: string) => string;
  verifyHmac: (body: string, signature: string) => Promise<boolean>;
};

type RequestIdentity = {
  authenticatedApiKeyHash: string | null;
  viewerKey: string;
  ipRangeKey: string;
  userOpenAiApiKey: string | null;
  isAuthenticated: boolean;
  canInvestigate: boolean;
  hasValidAttestation: boolean;
};

function trimToOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

async function resolveAuthenticatedApiKeyHash(input: {
  instanceApiKey: string | null;
  findActiveInstanceApiKeyHash: RequestIdentityDependencies["findActiveInstanceApiKeyHash"];
}): Promise<string | null> {
  if (input.instanceApiKey === null) {
    return null;
  }
  return input.findActiveInstanceApiKeyHash(input.instanceApiKey);
}

async function resolveViewerKey(input: {
  authenticatedApiKeyHash: string | null;
  clientAddress: string;
  userAgent: string;
  hashContent: RequestIdentityDependencies["hashContent"];
}): Promise<string> {
  if (input.authenticatedApiKeyHash !== null) {
    return input.hashContent(`apikey:${input.authenticatedApiKeyHash}`);
  }
  return input.hashContent(`anon:${input.clientAddress}:${input.userAgent}`);
}

async function resolveHasValidAttestation(input: {
  attestationSignature: string | null;
  attestationBody: string | null;
  verifyHmac: RequestIdentityDependencies["verifyHmac"];
}): Promise<boolean> {
  if (
    input.attestationSignature === null ||
    input.attestationBody === null ||
    input.attestationBody.length === 0
  ) {
    return false;
  }

  try {
    return await input.verifyHmac(input.attestationBody, input.attestationSignature);
  } catch {
    return false;
  }
}

export async function deriveRequestIdentity(
  input: RequestIdentityInput,
  dependencies: RequestIdentityDependencies,
): Promise<RequestIdentity> {
  const instanceApiKey = trimToOptional(input.instanceApiKey);
  const userOpenAiApiKey = trimToOptional(input.userOpenAiApiKey);
  const attestationSignature = trimToOptional(input.attestationSignature);

  const authenticatedApiKeyHash = await resolveAuthenticatedApiKeyHash({
    instanceApiKey,
    findActiveInstanceApiKeyHash: dependencies.findActiveInstanceApiKeyHash,
  });
  const viewerKey = await resolveViewerKey({
    authenticatedApiKeyHash,
    clientAddress: input.clientAddress,
    userAgent: input.userAgent,
    hashContent: dependencies.hashContent,
  });
  const ipRangePrefix = dependencies.deriveIpRangePrefix(input.clientAddress);
  const ipRangeKey = await dependencies.hashContent(`iprange:${ipRangePrefix}`);
  const hasValidAttestation = await resolveHasValidAttestation({
    attestationSignature,
    attestationBody: input.attestationBody,
    verifyHmac: dependencies.verifyHmac,
  });

  const isAuthenticated = authenticatedApiKeyHash !== null;
  const canInvestigate = isAuthenticated || userOpenAiApiKey !== null;

  return {
    authenticatedApiKeyHash,
    viewerKey,
    ipRangeKey,
    userOpenAiApiKey,
    isAuthenticated,
    canInvestigate,
    hasValidAttestation,
  };
}
