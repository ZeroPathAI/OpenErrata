import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_EXTENSION_SETTINGS,
  apiEndpointUrl,
  apiHostPermissionFor,
  normalizeApiBaseUrl,
  normalizeExtensionSettings,
} from "../../src/lib/settings-core";

test("normalizeApiBaseUrl accepts https URLs and local development http URLs", () => {
  assert.equal(normalizeApiBaseUrl("  https://api.openerrata.com/ "), "https://api.openerrata.com");
  assert.equal(normalizeApiBaseUrl("http://localhost:5173/"), "http://localhost:5173");
  assert.equal(normalizeApiBaseUrl("http://dev.localhost:5173/"), "http://dev.localhost:5173");
  assert.equal(
    normalizeApiBaseUrl("http://host.docker.internal:8080/"),
    "http://host.docker.internal:8080",
  );
  assert.equal(normalizeApiBaseUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(normalizeApiBaseUrl("http://192.168.1.12:3000/"), "http://192.168.1.12:3000");
  assert.equal(normalizeApiBaseUrl("http://172.20.1.12:3000/"), "http://172.20.1.12:3000");
  assert.equal(normalizeApiBaseUrl("http://10.10.10.10:3000/"), "http://10.10.10.10:3000");
  assert.equal(normalizeApiBaseUrl("http://0.0.0.0:3000/"), "http://0.0.0.0:3000");
  assert.equal(normalizeApiBaseUrl("http://localhost.:5173/"), "http://localhost.:5173");
  assert.equal(normalizeApiBaseUrl("http://[::1]:3000/"), "http://[::1]:3000");
  assert.equal(normalizeApiBaseUrl("http://[fd12:3456::1]:3000/"), "http://[fd12:3456::1]:3000");
  assert.equal(normalizeApiBaseUrl("http://[fe80::1]:3000/"), "http://[fe80::1]:3000");
});

test("normalizeApiBaseUrl rejects public http URLs, non-http(s), and malformed values", () => {
  assert.equal(normalizeApiBaseUrl(""), null);
  assert.equal(normalizeApiBaseUrl("http://api.openerrata.com"), null);
  assert.equal(normalizeApiBaseUrl("http://example.com"), null);
  assert.equal(normalizeApiBaseUrl("http://0.1.2.3:3000"), null);
  assert.equal(normalizeApiBaseUrl("http://[::ffff:c0a8:0101]:3000"), null);
  assert.equal(normalizeApiBaseUrl("http://[2001:db8::1]:3000"), null);
  assert.equal(normalizeApiBaseUrl("ftp://api.openerrata.com"), null);
  assert.equal(normalizeApiBaseUrl("not-a-url"), null);
  assert.equal(normalizeApiBaseUrl(42), null);
});

test("apiHostPermissionFor preserves explicit origin port", () => {
  assert.equal(apiHostPermissionFor("http://localhost:5173"), "http://localhost:5173/*");
  assert.equal(apiHostPermissionFor("https://api.openerrata.com"), "https://api.openerrata.com/*");
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
