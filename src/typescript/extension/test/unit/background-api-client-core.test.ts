import assert from "node:assert/strict";
import { test } from "node:test";
import { EXTENSION_TRPC_PATH } from "@openerrata/shared";
import { ApiClientError } from "../../src/background/api-client-error";
import {
  EXTENSION_VERSION_HEADER_NAME,
  TRPC_REQUEST_BODY_LIMIT_BYTES,
  assertTrpcResponseAccepted,
  buildTrpcRequestInit,
  clientKeyFor,
  shouldIncludeUserOpenAiKeyHeader,
} from "../../src/background/api-client-core";

const BASE_SETTINGS = {
  apiBaseUrl: "https://api.openerrata.com",
  apiKey: "",
  openaiApiKey: "",
};

test("clientKeyFor includes OpenAI key only when investigate-now header is enabled", () => {
  const settings = {
    ...BASE_SETTINGS,
    apiKey: "  api-key  ",
    openaiApiKey: "  sk-user-key  ",
  };

  assert.equal(clientKeyFor(settings, false), "https://api.openerrata.com|api-key|");
  assert.equal(clientKeyFor(settings, true), "https://api.openerrata.com|api-key|sk-user-key");
});

test("shouldIncludeUserOpenAiKeyHeader only enables user OpenAI key for investigateNow", () => {
  assert.equal(shouldIncludeUserOpenAiKeyHeader(EXTENSION_TRPC_PATH.INVESTIGATE_NOW), true);
  assert.equal(
    shouldIncludeUserOpenAiKeyHeader(EXTENSION_TRPC_PATH.RECORD_VIEW_AND_GET_STATUS),
    false,
  );
  assert.equal(shouldIncludeUserOpenAiKeyHeader(EXTENSION_TRPC_PATH.GET_INVESTIGATION), false);
  assert.equal(shouldIncludeUserOpenAiKeyHeader(EXTENSION_TRPC_PATH.VALIDATE_SETTINGS), false);
});

test("buildTrpcRequestInit adds API headers and keeps the request body", () => {
  const abortController = new AbortController();
  const body = '{"foo":"bar"}';
  const requestInit = buildTrpcRequestInit({
    init: {
      method: "POST",
      body,
      signal: abortController.signal,
      headers: {
        "content-type": "application/json",
      },
    },
    settings: {
      ...BASE_SETTINGS,
      apiKey: "  api-key-1  ",
      openaiApiKey: "  sk-user-1  ",
    },
    includeUserOpenAiHeader: true,
    extensionVersion: "0.1.4",
  });

  const headers = new Headers(requestInit.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-api-key"), "api-key-1");
  assert.equal(headers.get("x-openai-api-key"), "sk-user-1");
  assert.equal(headers.get(EXTENSION_VERSION_HEADER_NAME), "0.1.4");

  assert.equal(requestInit.method, "POST");
  assert.equal(requestInit.body, body);
  assert.equal(requestInit.signal, abortController.signal);
});

test("buildTrpcRequestInit omits the OpenAI header unless requested", () => {
  const requestInit = buildTrpcRequestInit({
    init: {
      method: "POST",
      body: "",
    },
    settings: {
      ...BASE_SETTINGS,
      apiKey: "api-key-2",
      openaiApiKey: "sk-user-2",
    },
    includeUserOpenAiHeader: false,
    extensionVersion: "0.1.4",
  });

  const headers = new Headers(requestInit.headers);
  assert.equal(headers.get("x-api-key"), "api-key-2");
  assert.equal(headers.get("x-openai-api-key"), null);
  assert.equal(headers.get(EXTENSION_VERSION_HEADER_NAME), "0.1.4");
});

test("buildTrpcRequestInit omits extension version header when extensionVersion is empty", () => {
  const requestInit = buildTrpcRequestInit({
    init: { method: "GET" },
    settings: BASE_SETTINGS,
    includeUserOpenAiHeader: false,
    extensionVersion: "",
  });

  const headers = new Headers(requestInit.headers);
  assert.equal(headers.get(EXTENSION_VERSION_HEADER_NAME), null);
});

test("buildTrpcRequestInit omits extension version header when extensionVersion is whitespace-only", () => {
  const requestInit = buildTrpcRequestInit({
    init: { method: "GET" },
    settings: BASE_SETTINGS,
    includeUserOpenAiHeader: false,
    extensionVersion: "   ",
  });

  const headers = new Headers(requestInit.headers);
  assert.equal(headers.get(EXTENSION_VERSION_HEADER_NAME), null);
});

test("buildTrpcRequestInit rejects oversized payloads with PAYLOAD_TOO_LARGE", () => {
  assert.throws(
    () =>
      buildTrpcRequestInit({
        init: {
          method: "POST",
          body: '{"too":"large"}',
        },
        settings: BASE_SETTINGS,
        includeUserOpenAiHeader: false,
        extensionVersion: "0.1.4",
        utf8Length: () => TRPC_REQUEST_BODY_LIMIT_BYTES + 1,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ApiClientError);
      assert.equal(error.errorCode, "PAYLOAD_TOO_LARGE");
      return true;
    },
  );
});

test("assertTrpcResponseAccepted throws on HTTP 413 and passes for non-413 statuses", () => {
  assert.throws(
    () => assertTrpcResponseAccepted(413),
    (error: unknown) => {
      assert.ok(error instanceof ApiClientError);
      assert.equal(error.errorCode, "PAYLOAD_TOO_LARGE");
      return true;
    },
  );

  assert.doesNotThrow(() => assertTrpcResponseAccepted(200));
  assert.doesNotThrow(() => assertTrpcResponseAccepted(500));
});
