import {
  EXTENSION_MESSAGE_PROTOCOL_VERSION,
  extensionRuntimeErrorResponseSchema,
} from "@openerrata/shared";

type ExtensionRuntimeErrorResponse = ReturnType<typeof extensionRuntimeErrorResponseSchema.parse>;

interface ProtocolMessageEnvelope {
  type: unknown;
  v: unknown;
}

function isProtocolMessageEnvelope(message: unknown): message is ProtocolMessageEnvelope {
  return typeof message === "object" && message !== null && "type" in message && "v" in message;
}

export function unsupportedProtocolVersionResponse(
  message: unknown,
): ExtensionRuntimeErrorResponse | null {
  if (!isProtocolMessageEnvelope(message)) {
    return null;
  }

  if (typeof message.type !== "string" || typeof message.v !== "number") {
    return null;
  }

  if (message.v === EXTENSION_MESSAGE_PROTOCOL_VERSION) {
    return null;
  }

  return extensionRuntimeErrorResponseSchema.parse({
    ok: false,
    error: `Unsupported extension message protocol version: expected ${EXTENSION_MESSAGE_PROTOCOL_VERSION}, received ${message.v}`,
    errorCode: "UNSUPPORTED_PROTOCOL_VERSION",
  });
}
