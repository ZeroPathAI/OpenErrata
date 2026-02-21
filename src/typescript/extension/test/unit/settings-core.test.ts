import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_EXTENSION_SETTINGS,
  apiEndpointUrl,
  apiHostPermissionFor,
  normalizeApiBaseUrl,
  normalizeExtensionSettings,
} from "../../src/lib/settings-core";

test("normalizeApiBaseUrl accepts http(s) and strips trailing slash", () => {
  assert.equal(
    normalizeApiBaseUrl("  https://api.openerrata.com/ "),
    "https://api.openerrata.com",
  );
  assert.equal(
    normalizeApiBaseUrl("http://localhost:5173/"),
    "http://localhost:5173",
  );
});

test("normalizeApiBaseUrl rejects non-http(s) and malformed values", () => {
  assert.equal(normalizeApiBaseUrl(""), null);
  assert.equal(normalizeApiBaseUrl("ftp://api.openerrata.com"), null);
  assert.equal(normalizeApiBaseUrl("not-a-url"), null);
  assert.equal(normalizeApiBaseUrl(42), null);
});

test("apiHostPermissionFor preserves explicit origin port", () => {
  assert.equal(
    apiHostPermissionFor("http://localhost:5173"),
    "http://localhost:5173/*",
  );
  assert.equal(
    apiHostPermissionFor("https://api.openerrata.com"),
    "https://api.openerrata.com/*",
  );
});

test("apiEndpointUrl resolves endpoint paths from API base URL", () => {
  assert.equal(
    apiEndpointUrl("https://api.openerrata.com", "/trpc"),
    "https://api.openerrata.com/trpc",
  );
  assert.equal(
    apiEndpointUrl("https://api.openerrata.com/", "trpc"),
    "https://api.openerrata.com/trpc",
  );
});

test("normalizeExtensionSettings applies defaults and trims values", () => {
  assert.deepEqual(
    normalizeExtensionSettings({
      apiBaseUrl: "https://localhost:5173/",
      apiKey: "  key-123  ",
      openaiApiKey: "  sk-user-key  ",
      autoInvestigate: true,
      hmacSecret: "  hmac-secret  ",
    }),
    {
      apiBaseUrl: "https://localhost:5173",
      apiKey: "key-123",
      openaiApiKey: "sk-user-key",
      autoInvestigate: true,
      hmacSecret: "hmac-secret",
    },
  );

  assert.deepEqual(normalizeExtensionSettings({}), DEFAULT_EXTENSION_SETTINGS);
});
