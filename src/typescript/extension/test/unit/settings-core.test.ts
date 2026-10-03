import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_API_BASE_URL,
  apiEndpointUrl,
  apiHostPermissionFor,
  normalizeApiBaseUrl,
  parseStoredSettings,
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

test("parseStoredSettings trims values and defaults only what was never set", () => {
  assert.deepEqual(
    parseStoredSettings({
      apiBaseUrl: "https://localhost:5173/",
      apiKey: "  key-123  ",
      openaiApiKey: "  sk-user-key  ",
      autoInvestigate: true,
    }),
    {
      kind: "VALID",
      settings: {
        apiBaseUrl: "https://localhost:5173",
        apiKey: "key-123",
        openaiApiKey: "sk-user-key",
        autoInvestigate: true,
      },
    },
  );

  assert.deepEqual(parseStoredSettings({}), {
    kind: "VALID",
    settings: {
      apiBaseUrl: DEFAULT_API_BASE_URL,
      apiKey: "",
      openaiApiKey: "",
      autoInvestigate: false,
    },
  });
});

test("an invalid stored API URL is an error, never silently replaced by the hosted API", () => {
  const parsed = parseStoredSettings({ apiBaseUrl: "http://selfhosted.example.com" });
  assert.equal(parsed.kind, "INVALID");
  assert.match(parsed.kind === "INVALID" ? parsed.problem : "", /selfhosted\.example\.com/);
});

test("stored settings of the wrong type are reported, not coerced", () => {
  assert.equal(parseStoredSettings({ autoInvestigate: "yes" }).kind, "INVALID");
  assert.equal(parseStoredSettings({ apiKey: 42 }).kind, "INVALID");
});
