import assert from "node:assert/strict";
import { test } from "node:test";
import { validateOpenAiApiKeyForSettingsWithReachability } from "../../src/lib/services/openai-key-validation-core.js";

test("validateOpenAiApiKeyForSettingsWithReachability returns missing for empty values", async () => {
  const result = await validateOpenAiApiKeyForSettingsWithReachability("   ", async () => {
    throw new Error("should not run");
  });

  assert.deepEqual(result, { openaiApiKeyStatus: "missing" });
});

test("validateOpenAiApiKeyForSettingsWithReachability returns format_invalid for malformed keys", async () => {
  const result = await validateOpenAiApiKeyForSettingsWithReachability("invalid-key", async () => {
    throw new Error("should not run");
  });

  assert.deepEqual(result, {
    openaiApiKeyStatus: "format_invalid",
    openaiApiKeyMessage: "OpenAI API keys must begin with sk- and include the full token value.",
  });
});

test("validateOpenAiApiKeyForSettingsWithReachability returns valid on successful reachability check", async () => {
  const result = await validateOpenAiApiKeyForSettingsWithReachability(
    "sk-valid-test-key-abcdefghijklmnopqrstuvwxyz",
    async () => {},
  );

  assert.deepEqual(result, { openaiApiKeyStatus: "valid" });
});

test("validateOpenAiApiKeyForSettingsWithReachability maps known OpenAI status codes", async () => {
  const invalidResult = await validateOpenAiApiKeyForSettingsWithReachability(
    "sk-invalid-test-key-abcdefghijklmnopqrstuvwxyz",
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub with additional status property
      const error = new Error("unauthorized") as Error & { status: number };
      error.status = 401;
      throw error;
    },
  );
  assert.deepEqual(invalidResult, {
    openaiApiKeyStatus: "invalid",
    openaiApiKeyMessage: "OpenAI rejected this API key.",
  });

  const restrictedResult = await validateOpenAiApiKeyForSettingsWithReachability(
    "sk-restricted-test-key-abcdefghijklmnopqrstuvwxyz",
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub with additional status property
      const error = new Error("forbidden") as Error & { status: number };
      error.status = 403;
      throw error;
    },
  );
  assert.deepEqual(restrictedResult, {
    openaiApiKeyStatus: "authenticated_restricted",
    openaiApiKeyMessage:
      "OpenAI authenticated this key, but access is restricted for validation checks.",
  });
});

test("validateOpenAiApiKeyForSettingsWithReachability handles timeout and generic failures", async () => {
  const timeoutResult = await validateOpenAiApiKeyForSettingsWithReachability(
    "sk-timeout-test-key-abcdefghijklmnopqrstuvwxyz",
    async () => {
      const error = new Error("timed out");
      error.name = "AbortError";
      throw error;
    },
  );
  assert.deepEqual(timeoutResult, {
    openaiApiKeyStatus: "error",
    openaiApiKeyMessage:
      "OpenAI key validation timed out. Confirm outbound network access and retry.",
  });

  const genericResult = await validateOpenAiApiKeyForSettingsWithReachability(
    "sk-generic-test-key-abcdefghijklmnopqrstuvwxyz",
    async () => {
      throw new Error("network is blocked");
    },
  );
  assert.deepEqual(genericResult, {
    openaiApiKeyStatus: "error",
    openaiApiKeyMessage: "network is blocked",
  });
});
