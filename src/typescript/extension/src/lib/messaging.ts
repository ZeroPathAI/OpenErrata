/**
 * Typed request/response helpers over the extension message protocol
 * (`BACKGROUND_REQUESTS` / `CONTENT_REQUESTS` in the shared package). Senders
 * get typed responses, handlers are a table keyed by message type, and both
 * sides validate what they receive against the same request map.
 *
 * This module takes the transport (`runtime.sendMessage` / `tabs.sendMessage`)
 * as a parameter so it stays free of browser globals.
 */
import {
  BACKGROUND_REQUESTS,
  CONTENT_REQUESTS,
  parseBackgroundRequestPayload,
  parseBackgroundResponseEnvelope,
  parseContentRequestPayload,
  parseContentResponseEnvelope,
  type BackgroundRequestPayload,
  type BackgroundRequestType,
  type BackgroundResponse,
  type ContentRequestPayload,
  type ContentRequestType,
  type ContentResponse,
  type ExtensionRuntimeErrorResponse,
  type ProtocolParseResult,
  type ProtocolResponseEnvelope,
} from "@openerrata/shared";
import { ExtensionRuntimeError, isNoReceivingEndError } from "./runtime-error.js";

type ResponseEnvelope = { ok: true; value: unknown } | ExtensionRuntimeErrorResponse;

/** What a runtime message listener returns: always a promise, so error replies are delivered too. */
type ListenerReply = Promise<ResponseEnvelope>;

export type BackgroundRequestHandlers<Sender> = {
  [Type in BackgroundRequestType]: (
    payload: BackgroundRequestPayload<Type>,
    sender: Sender,
  ) => Promise<BackgroundResponse<Type>>;
};

export type ContentRequestHandlers = {
  [Type in ContentRequestType]: (
    payload: ContentRequestPayload<Type>,
  ) => Promise<ContentResponse<Type>> | ContentResponse<Type>;
};

function invalidMessageReply(error: string): ListenerReply {
  return Promise.resolve({ ok: false, error, errorCode: "INVALID_EXTENSION_MESSAGE" });
}

function readEnvelope(message: unknown): { type: string; payload: unknown } | null {
  if (typeof message !== "object" || message === null) return null;
  if (!("type" in message) || !("payload" in message)) return null;
  const { type, payload } = message;
  return typeof type === "string" ? { type, payload } : null;
}

/** The value of a response envelope, or its error as an `ExtensionRuntimeError`. */
function unwrapEnvelope<Value>(
  type: string,
  envelope: ProtocolParseResult<ProtocolResponseEnvelope<Value>>,
): Value {
  if (!envelope.success) {
    throw new ExtensionRuntimeError(
      `Malformed ${type} response: ${envelope.error}`,
      "INVALID_EXTENSION_MESSAGE",
    );
  }
  if (!envelope.data.ok) {
    throw new ExtensionRuntimeError(envelope.data.error, envelope.data.errorCode);
  }
  return envelope.data.value;
}

function isBackgroundRequestType(type: string): type is BackgroundRequestType {
  return Object.hasOwn(BACKGROUND_REQUESTS, type);
}

function isContentRequestType(type: string): type is ContentRequestType {
  return Object.hasOwn(CONTENT_REQUESTS, type);
}

// ── Background requests (content script / popup → background) ─────────────

export async function sendBackgroundRequest<Type extends BackgroundRequestType>(
  sendMessage: (message: unknown) => Promise<unknown>,
  type: Type,
  payload: BackgroundRequestPayload<Type>,
): Promise<BackgroundResponse<Type>> {
  const raw = await sendMessage({ type, payload });
  return unwrapEnvelope(type, parseBackgroundResponseEnvelope(type, raw));
}

async function dispatchBackgroundRequest<Type extends BackgroundRequestType, Sender>(
  type: Type,
  handler: BackgroundRequestHandlers<Sender>[Type],
  rawPayload: unknown,
  sender: Sender,
): Promise<ResponseEnvelope> {
  const payload = parseBackgroundRequestPayload(type, rawPayload);
  if (!payload.success) {
    return invalidMessageReply(`Invalid ${type} payload: ${payload.error}`);
  }
  return { ok: true, value: await handler(payload.data, sender) };
}

/**
 * A `runtime.onMessage` listener serving the background request map. Handler
 * failures become `{ ok: false }` replies via `toErrorResponse`.
 */
export function createBackgroundRequestListener<Sender>(
  handlers: BackgroundRequestHandlers<Sender>,
  toErrorResponse: (error: unknown) => Promise<ExtensionRuntimeErrorResponse>,
): (message: unknown, sender: Sender) => ListenerReply {
  return (message, sender) => {
    const envelope = readEnvelope(message);
    if (envelope === null || !isBackgroundRequestType(envelope.type)) {
      return invalidMessageReply("Unrecognized background request");
    }
    return dispatchBackgroundRequest(
      envelope.type,
      handlers[envelope.type],
      envelope.payload,
      sender,
    ).catch(toErrorResponse);
  };
}

// ── Content requests (background / popup → content script) ────────────────

/** Outcome of messaging a tab: its content script answered, or the tab has none. */
export type TabDelivery<Value> = { kind: "DELIVERED"; value: Value } | { kind: "NO_RECEIVER" };

export async function sendContentRequest<Type extends ContentRequestType>(
  sendTabMessage: (message: unknown) => Promise<unknown>,
  type: Type,
  payload: ContentRequestPayload<Type>,
): Promise<TabDelivery<ContentResponse<Type>>> {
  let raw: unknown;
  try {
    raw = await sendTabMessage({ type, payload });
  } catch (error) {
    if (isNoReceivingEndError(error)) {
      return { kind: "NO_RECEIVER" };
    }
    throw error;
  }
  return {
    kind: "DELIVERED",
    value: unwrapEnvelope(type, parseContentResponseEnvelope(type, raw)),
  };
}

async function dispatchContentRequest<Type extends ContentRequestType>(
  type: Type,
  handler: ContentRequestHandlers[Type],
  rawPayload: unknown,
): Promise<ResponseEnvelope> {
  const payload = parseContentRequestPayload(type, rawPayload);
  if (!payload.success) {
    return invalidMessageReply(`Invalid ${type} payload: ${payload.error}`);
  }
  return { ok: true, value: await handler(payload.data) };
}

/** A `runtime.onMessage` listener for a content script, serving the content request map. */
export function createContentRequestListener(
  handlers: ContentRequestHandlers,
  toErrorResponse: (error: unknown) => ExtensionRuntimeErrorResponse,
): (message: unknown) => ListenerReply {
  return (message) => {
    const envelope = readEnvelope(message);
    if (envelope === null || !isContentRequestType(envelope.type)) {
      return invalidMessageReply("Unrecognized content request");
    }
    return dispatchContentRequest(envelope.type, handlers[envelope.type], envelope.payload).catch(
      (error: unknown) => toErrorResponse(error),
    );
  };
}
