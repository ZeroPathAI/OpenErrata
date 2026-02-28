import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCachedStatusResponse,
  parseInvestigateNowResponse,
  parseViewPostResponse,
} from "../../src/lib/sync-response.js";
import { ExtensionRuntimeError } from "../../src/lib/runtime-error.js";

test("parseViewPostResponse returns parsed NOT_INVESTIGATED payload", () => {
  const parsed = parseViewPostResponse({
    investigationState: "NOT_INVESTIGATED",
    claims: null,
    priorInvestigationResult: null,
  });

  assert.equal(parsed.investigationState, "NOT_INVESTIGATED");
  assert.equal(parsed.claims, null);
});

test("parseViewPostResponse preserves runtime error payloads", () => {
  assert.throws(
    () =>
      parseViewPostResponse({
        ok: false,
        error: "payload too large",
        errorCode: "PAYLOAD_TOO_LARGE",
      }),
    (error: unknown) =>
      error instanceof ExtensionRuntimeError &&
      error.errorCode === "PAYLOAD_TOO_LARGE" &&
      error.message === "payload too large",
  );
});

test("parseInvestigateNowResponse preserves UPGRADE_REQUIRED runtime error payloads", () => {
  assert.throws(
    () =>
      parseInvestigateNowResponse({
        ok: false,
        error: "upgrade required",
        errorCode: "UPGRADE_REQUIRED",
      }),
    (error: unknown) =>
      error instanceof ExtensionRuntimeError &&
      error.errorCode === "UPGRADE_REQUIRED" &&
      error.message === "upgrade required",
  );
});

test("parseViewPostResponse throws ExtensionRuntimeError for malformed responses", () => {
  assert.throws(
    () => parseViewPostResponse(undefined),
    (error: unknown) =>
      error instanceof ExtensionRuntimeError &&
      error.errorCode === "INVALID_EXTENSION_MESSAGE" &&
      error.message.includes("Malformed PAGE_CONTENT response from background:"),
  );
});

test("parseInvestigateNowResponse returns parsed payload", () => {
  const parsed = parseInvestigateNowResponse({
    investigationId: "investigation-123",
    status: "PENDING",
    provenance: "SERVER_VERIFIED",
  });

  assert.equal(parsed.status, "PENDING");
  assert.equal(parsed.investigationId, "investigation-123");
});

test("parseInvestigateNowResponse throws ExtensionRuntimeError for malformed responses", () => {
  assert.throws(
    () => parseInvestigateNowResponse(null),
    (error: unknown) =>
      error instanceof ExtensionRuntimeError &&
      error.errorCode === "INVALID_EXTENSION_MESSAGE" &&
      error.message.includes("Malformed INVESTIGATE_NOW response from background:"),
  );
});

test("parseCachedStatusResponse returns null for empty cache", () => {
  assert.equal(parseCachedStatusResponse(null), null);
});

test("parseCachedStatusResponse returns parsed cached POST status", () => {
  const parsed = parseCachedStatusResponse({
    kind: "POST",
    tabSessionId: 1,
    platform: "X",
    externalId: "1900000000000000000",
    pageUrl: "https://x.com/example/status/1900000000000000000",
    investigationState: "NOT_INVESTIGATED",
    claims: null,
    priorInvestigationResult: null,
  });

  if (parsed === null) {
    throw new Error("expected parsed cached status");
  }

  assert.equal(parsed.kind, "POST");
  assert.equal(parsed.investigationState, "NOT_INVESTIGATED");
});

test("parseCachedStatusResponse throws INVALID_EXTENSION_MESSAGE for malformed responses", () => {
  assert.throws(
    () => parseCachedStatusResponse({ kind: "POST" }),
    (error: unknown) =>
      error instanceof ExtensionRuntimeError &&
      error.errorCode === "INVALID_EXTENSION_MESSAGE" &&
      error.message.includes("Malformed GET_CACHED response from background:"),
  );
});
