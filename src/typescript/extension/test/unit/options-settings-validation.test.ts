import assert from "node:assert/strict";
import { test } from "node:test";
import { EXTENSION_TRPC_PATH } from "@openerrata/shared";

type SettingsValidationModule = typeof import("../../src/options/settings-validation");

function installChromeRuntimeOnly(): void {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      id: "test-extension",
      getURL: (asset: string) => `chrome-extension://test-extension/${asset}`,
    },
  };
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

async function importSettingsValidationModule(): Promise<SettingsValidationModule> {
  installChromeRuntimeOnly();
  return (await import(
    `../../src/options/settings-validation.ts?test=${Date.now().toString()}-${Math.random().toString()}`
  )) as SettingsValidationModule;
}

function requestUrlString(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function assertProbeErrorContains(
  result: Awaited<ReturnType<SettingsValidationModule["probeSettingsConfiguration"]>>,
  messageParts: readonly string[],
): void {
  assert.equal(result.status, "error");
  for (const messagePart of messageParts) {
    assert.equal(
      result.message.includes(messagePart),
      true,
      `Expected error message to include "${messagePart}" but got "${result.message}"`,
    );
  }
}

test("getOpenaiApiKeyFormatError validates key format only when key is non-empty", async () => {
  const { getOpenaiApiKeyFormatError } = await importSettingsValidationModule();

  assert.equal(getOpenaiApiKeyFormatError("   "), null);
  assert.equal(
    getOpenaiApiKeyFormatError("bad-key"),
    "OpenAI API key must start with sk- and include the full token.",
  );
  assert.equal(getOpenaiApiKeyFormatError("sk-abcdefghijklmnopqrstuvwxyz12345"), null);
});

test("probeSettingsConfiguration rejects invalid API base URL before network calls", async () => {
  const { API_BASE_URL_REQUIREMENTS_MESSAGE } = await import("../../src/lib/settings-core");
  const { probeSettingsConfiguration } = await importSettingsValidationModule();
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response();
  }) as typeof fetch;

  try {
    const result = await probeSettingsConfiguration({
      apiBaseUrl: "http://example.com",
      apiKey: "",
      openaiApiKey: "",
    });

    assert.deepEqual(result, {
      status: "error",
      message: API_BASE_URL_REQUIREMENTS_MESSAGE,
    });
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeSettingsConfiguration reports health endpoint HTTP failures", async () => {
  const { probeSettingsConfiguration } = await importSettingsValidationModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await probeSettingsConfiguration({
      apiBaseUrl: "https://api.openerrata.example",
      apiKey: "",
      openaiApiKey: "",
    });
    assertProbeErrorContains(result, ["Health check failed", "503"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeSettingsConfiguration reports malformed health JSON responses", async () => {
  const { probeSettingsConfiguration } = await importSettingsValidationModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await probeSettingsConfiguration({
      apiBaseUrl: "https://api.openerrata.example",
      apiKey: "",
      openaiApiKey: "",
    });
    assertProbeErrorContains(result, ["Health check response", "not valid JSON"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeSettingsConfiguration reports health payload contract mismatches", async () => {
  const { probeSettingsConfiguration } = await importSettingsValidationModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ status: "degraded" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await probeSettingsConfiguration({
      apiBaseUrl: "https://api.openerrata.example",
      apiKey: "",
      openaiApiKey: "",
    });
    assertProbeErrorContains(result, ["Health check response", "API contract"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeSettingsConfiguration reports health endpoint timeout/abort failures", async () => {
  const { probeSettingsConfiguration } = await importSettingsValidationModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw abortError("health aborted");
  }) as typeof fetch;

  try {
    const result = await probeSettingsConfiguration({
      apiBaseUrl: "https://api.openerrata.example",
      apiKey: "",
      openaiApiKey: "",
    });
    assertProbeErrorContains(result, ["Health check timed out"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeSettingsConfiguration reports network reachability failures for health endpoint", async () => {
  const { probeSettingsConfiguration } = await importSettingsValidationModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("connection refused");
  }) as typeof fetch;

  try {
    const result = await probeSettingsConfiguration({
      apiBaseUrl: "https://api.openerrata.example",
      apiKey: "",
      openaiApiKey: "",
    });
    assertProbeErrorContains(result, ["Could not reach API health endpoint", "connection refused"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeSettingsConfiguration returns ok when health and validation succeed", async () => {
  const { probeSettingsConfiguration } = await importSettingsValidationModule();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = requestUrlString(input);
    fetchCalls.push({
      url,
      method: init?.method ?? "GET",
    });

    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        result: {
          data: {
            instanceApiKeyAccepted: true,
            openaiApiKeyStatus: "valid",
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await probeSettingsConfiguration({
      apiBaseUrl: "https://api.openerrata.example",
      apiKey: "instance-key",
      openaiApiKey: "sk-user-token-1234567890",
    });

    assert.deepEqual(result, {
      status: "ok",
      validation: {
        instanceApiKeyAccepted: true,
        openaiApiKeyStatus: "valid",
      },
    });
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0]?.url, "https://api.openerrata.example/health");
    assert.equal(
      fetchCalls[1]?.url,
      `https://api.openerrata.example/trpc/${EXTENSION_TRPC_PATH.VALIDATE_SETTINGS}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeSettingsConfiguration reports validation schema mismatches", async () => {
  const { probeSettingsConfiguration } = await importSettingsValidationModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = requestUrlString(input);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        result: {
          data: {
            instanceApiKeyAccepted: true,
            openaiApiKeyStatus: "unknown_state",
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await probeSettingsConfiguration({
      apiBaseUrl: "https://api.openerrata.example",
      apiKey: "",
      openaiApiKey: "",
    });
    assertProbeErrorContains(result, ["Validation response", "API contract"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeSettingsConfiguration reports missing validateSettings procedure distinctly", async () => {
  const { probeSettingsConfiguration } = await importSettingsValidationModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = requestUrlString(input);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        error: {
          code: -32004,
          message: `No procedure ${EXTENSION_TRPC_PATH.VALIDATE_SETTINGS} here`,
          data: {
            code: "NOT_FOUND",
          },
        },
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await probeSettingsConfiguration({
      apiBaseUrl: "https://api.openerrata.example",
      apiKey: "",
      openaiApiKey: "",
    });
    assertProbeErrorContains(result, [
      "Server is reachable but missing",
      EXTENSION_TRPC_PATH.VALIDATE_SETTINGS,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeSettingsConfiguration reports validation timeout/abort failures", async () => {
  const { probeSettingsConfiguration } = await importSettingsValidationModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = requestUrlString(input);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw abortError("validation aborted");
  }) as typeof fetch;

  try {
    const result = await probeSettingsConfiguration({
      apiBaseUrl: "https://api.openerrata.example",
      apiKey: "",
      openaiApiKey: "",
    });
    assertProbeErrorContains(result, ["Settings validation", "validation aborted"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeSettingsConfiguration reports generic validation failures", async () => {
  const { probeSettingsConfiguration } = await importSettingsValidationModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = requestUrlString(input);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("validation exploded");
  }) as typeof fetch;

  try {
    const result = await probeSettingsConfiguration({
      apiBaseUrl: "https://api.openerrata.example",
      apiKey: "",
      openaiApiKey: "",
    });
    assertProbeErrorContains(result, ["Settings validation", "validation exploded"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
