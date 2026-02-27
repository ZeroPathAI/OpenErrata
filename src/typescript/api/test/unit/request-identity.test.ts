import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveRequestIdentity } from "../../src/lib/services/request-identity.js";

test("deriveRequestIdentity uses authenticated viewer key path when api key is active", async () => {
  const lookedUpApiKeys: string[] = [];
  const verifiedSignatures: Array<{ body: string; signature: string }> = [];

  const identity = await deriveRequestIdentity(
    {
      clientAddress: "203.0.113.7",
      userAgent: "UnitTestBrowser/1.0",
      instanceApiKey: " live-key ",
      userOpenAiApiKey: " sk-user ",
      attestationSignature: "sig-v1",
      attestationBody: '{"hello":"world"}',
    },
    {
      hashContent: async (value) => `hash:${value}`,
      findActiveInstanceApiKeyHash: async (apiKey) => {
        lookedUpApiKeys.push(apiKey);
        return apiKey === "live-key" ? "api-hash" : null;
      },
      deriveIpRangePrefix: (address) => `prefix:${address}`,
      verifyHmac: async (body, signature) => {
        verifiedSignatures.push({ body, signature });
        return true;
      },
    },
  );

  assert.deepEqual(lookedUpApiKeys, ["live-key"]);
  assert.deepEqual(verifiedSignatures, [{ body: '{"hello":"world"}', signature: "sig-v1" }]);
  assert.deepEqual(identity, {
    authenticatedApiKeyHash: "api-hash",
    viewerKey: "hash:apikey:api-hash",
    ipRangeKey: "hash:iprange:prefix:203.0.113.7",
    userOpenAiApiKey: "sk-user",
    isAuthenticated: true,
    canInvestigate: true,
    hasValidAttestation: true,
  });
});

test("deriveRequestIdentity uses anonymous viewer key path when api key is absent", async () => {
  let lookupCount = 0;
  const identity = await deriveRequestIdentity(
    {
      clientAddress: "198.51.100.11",
      userAgent: "UnitTestBrowser/2.0",
      instanceApiKey: "  ",
      userOpenAiApiKey: null,
      attestationSignature: null,
      attestationBody: null,
    },
    {
      hashContent: async (value) => `hash:${value}`,
      findActiveInstanceApiKeyHash: async () => {
        lookupCount += 1;
        return "should-not-be-used";
      },
      deriveIpRangePrefix: (address) => `prefix:${address}`,
      verifyHmac: async () => true,
    },
  );

  assert.equal(lookupCount, 0);
  assert.deepEqual(identity, {
    authenticatedApiKeyHash: null,
    viewerKey: "hash:anon:198.51.100.11:UnitTestBrowser/2.0",
    ipRangeKey: "hash:iprange:prefix:198.51.100.11",
    userOpenAiApiKey: null,
    isAuthenticated: false,
    canInvestigate: false,
    hasValidAttestation: false,
  });
});

test("deriveRequestIdentity allows investigate with user-provided OpenAI key", async () => {
  const identity = await deriveRequestIdentity(
    {
      clientAddress: "192.0.2.44",
      userAgent: "UnitTestBrowser/3.0",
      instanceApiKey: null,
      userOpenAiApiKey: "  sk-openai  ",
      attestationSignature: null,
      attestationBody: "",
    },
    {
      hashContent: async (value) => `hash:${value}`,
      findActiveInstanceApiKeyHash: async () => null,
      deriveIpRangePrefix: (address) => `prefix:${address}`,
      verifyHmac: async () => true,
    },
  );

  assert.equal(identity.isAuthenticated, false);
  assert.equal(identity.userOpenAiApiKey, "sk-openai");
  assert.equal(identity.canInvestigate, true);
});

test("deriveRequestIdentity marks attestation invalid when verifier throws", async () => {
  const identity = await deriveRequestIdentity(
    {
      clientAddress: "198.18.0.5",
      userAgent: "UnitTestBrowser/4.0",
      instanceApiKey: null,
      userOpenAiApiKey: null,
      attestationSignature: "sig-v1",
      attestationBody: "payload",
    },
    {
      hashContent: async (value) => `hash:${value}`,
      findActiveInstanceApiKeyHash: async () => null,
      deriveIpRangePrefix: (address) => `prefix:${address}`,
      verifyHmac: async () => {
        throw new Error("boom");
      },
    },
  );

  assert.equal(identity.hasValidAttestation, false);
});
