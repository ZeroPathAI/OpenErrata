import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveRequestIdentity } from "../../src/lib/services/request-identity.js";

const dependencies = {
  hashContent: async (value: string) => `hash:${value}`,
  deriveIpRangePrefix: (address: string) => `prefix:${address}`,
};

test("deriveRequestIdentity keys authenticated viewers by their instance API key", async () => {
  const lookedUpApiKeys: string[] = [];

  const identity = await deriveRequestIdentity(
    {
      clientAddress: "203.0.113.7",
      userAgent: "UnitTestBrowser/1.0",
      instanceApiKey: " live-key ",
      userOpenAiApiKey: " sk-user ",
    },
    {
      ...dependencies,
      findActiveInstanceApiKeyHash: async (apiKey) => {
        lookedUpApiKeys.push(apiKey);
        return apiKey === "live-key" ? "api-hash" : null;
      },
    },
  );

  assert.deepEqual(lookedUpApiKeys, ["live-key"]);
  assert.deepEqual(identity, {
    viewerKey: "hash:apikey:api-hash",
    ipRangeKey: "hash:iprange:prefix:203.0.113.7",
    isAuthenticated: true,
    userOpenAiApiKey: "sk-user",
  });
});

test("deriveRequestIdentity keys anonymous viewers by address and user agent", async () => {
  let lookupCount = 0;
  const identity = await deriveRequestIdentity(
    {
      clientAddress: "198.51.100.11",
      userAgent: "UnitTestBrowser/2.0",
      instanceApiKey: "  ",
      userOpenAiApiKey: null,
    },
    {
      ...dependencies,
      findActiveInstanceApiKeyHash: async () => {
        lookupCount += 1;
        return "should-not-be-used";
      },
    },
  );

  assert.equal(lookupCount, 0);
  assert.deepEqual(identity, {
    viewerKey: "hash:anon:198.51.100.11:UnitTestBrowser/2.0",
    ipRangeKey: "hash:iprange:prefix:198.51.100.11",
    isAuthenticated: false,
    userOpenAiApiKey: null,
  });
});

test("deriveRequestIdentity treats an unknown or revoked instance key as anonymous", async () => {
  const identity = await deriveRequestIdentity(
    {
      clientAddress: "198.51.100.12",
      userAgent: "UnitTestBrowser/3.0",
      instanceApiKey: "revoked-key",
      userOpenAiApiKey: "sk-user",
    },
    { ...dependencies, findActiveInstanceApiKeyHash: async () => null },
  );

  assert.equal(identity.isAuthenticated, false);
  assert.equal(identity.viewerKey, "hash:anon:198.51.100.12:UnitTestBrowser/3.0");
  assert.equal(identity.userOpenAiApiKey, "sk-user");
});
