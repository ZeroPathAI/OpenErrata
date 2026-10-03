import assert from "node:assert/strict";
import { test } from "node:test";
import type { BackgroundRequestHandlers, ContentRequestHandlers } from "../../src/lib/messaging";
import {
  createBackgroundRequestListener,
  createContentRequestListener,
  sendBackgroundRequest,
  sendContentRequest,
} from "../../src/lib/messaging";
import { ExtensionRuntimeError } from "../../src/lib/runtime-error";
import { notInvestigatedStatus, sessionId } from "../helpers/statuses";

interface Sender {
  tab?: { id?: number };
}

function backgroundHandlers(overrides: Partial<BackgroundRequestHandlers<Sender>> = {}) {
  const unexpected = () => Promise.reject(new Error("unexpected request"));
  const handlers: BackgroundRequestHandlers<Sender> = {
    PAGE_CONTENT: unexpected,
    PAGE_SKIPPED: unexpected,
    PAGE_RESET: () => Promise.resolve(null),
    INVESTIGATE_NOW: unexpected,
    GET_TAB_STATUS: ({ tabId }) =>
      Promise.resolve({
        kind: "STATUS",
        status: tabId === 4 ? notInvestigatedStatus(sessionId(1)) : null,
      }),
    ...overrides,
  };
  return handlers;
}

function errorResponse(error: unknown) {
  return Promise.resolve({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  });
}

test("background requests round-trip with typed, validated responses", async () => {
  const listener = createBackgroundRequestListener(backgroundHandlers(), errorResponse);
  const response = await sendBackgroundRequest(
    (message) => listener(message, {}),
    "GET_TAB_STATUS",
    {
      tabId: 4,
    },
  );
  assert.deepEqual(response, { kind: "STATUS", status: notInvestigatedStatus(sessionId(1)) });
});

test("invalid requests get an error reply (a promise, so it is delivered) instead of silence", async () => {
  const listener = createBackgroundRequestListener(backgroundHandlers(), errorResponse);

  const unknownType = listener({ type: "GET_CACHED", payload: null }, {});
  assert.ok(unknownType instanceof Promise);
  assert.deepEqual(await unknownType, {
    ok: false,
    error: "Unrecognized background request",
    errorCode: "INVALID_EXTENSION_MESSAGE",
  });

  const badPayload = await listener({ type: "PAGE_RESET", payload: { tabSessionId: 3 } }, {});
  assert.equal(badPayload.ok, false);
  assert.equal(!badPayload.ok && badPayload.errorCode, "INVALID_EXTENSION_MESSAGE");
});

test("handler failures reach the sender as ExtensionRuntimeErrors with their code", async () => {
  const listener = createBackgroundRequestListener(
    backgroundHandlers({ PAGE_RESET: () => Promise.reject(new Error("storage failed")) }),
    (error) =>
      Promise.resolve({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: "PAYLOAD_TOO_LARGE",
      }),
  );

  await assert.rejects(
    sendBackgroundRequest((message) => listener(message, {}), "PAGE_RESET", {
      tabSessionId: sessionId(1),
    }),
    (error: unknown) =>
      error instanceof ExtensionRuntimeError &&
      error.message === "storage failed" &&
      error.errorCode === "PAYLOAD_TOO_LARGE",
  );
});

test("a malformed response is reported as an invalid extension message", async () => {
  await assert.rejects(
    sendBackgroundRequest(() => Promise.resolve(undefined), "PAGE_RESET", {
      tabSessionId: sessionId(1),
    }),
    (error: unknown) =>
      error instanceof ExtensionRuntimeError && error.errorCode === "INVALID_EXTENSION_MESSAGE",
  );
});

test("content requests distinguish a tab without a content script from a failing one", async () => {
  const handlers: ContentRequestHandlers = {
    PING: () => ({ alive: true }),
    GET_VISIBILITY: () => ({ visible: false }),
    SHOW_ANNOTATIONS: () => ({ visible: true }),
    HIDE_ANNOTATIONS: () => ({ visible: false }),
    REQUEST_INVESTIGATE: () => ({ ok: false }),
    FOCUS_CLAIM: () => ({ ok: false }),
    LOCATION_CHANGED: () => null,
    STATUS_CHANGED: () => null,
  };
  const listener = createContentRequestListener(handlers, (error) => ({
    ok: false,
    error: String(error),
  }));

  assert.deepEqual(await sendContentRequest(listener, "PING", null), {
    kind: "DELIVERED",
    value: { alive: true },
  });
  assert.deepEqual(
    await sendContentRequest(
      () =>
        Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")),
      "PING",
      null,
    ),
    { kind: "NO_RECEIVER" },
  );
  await assert.rejects(
    sendContentRequest(() => Promise.reject(new Error("Tab crashed")), "PING", null),
    /Tab crashed/,
  );
});
