import type { ExtensionRuntimeErrorCode } from "@openerrata/shared";

export const UPGRADE_REQUIRED_STORAGE_KEY = "runtime:upgrade-required";

export class ExtensionRuntimeError extends Error {
  readonly errorCode: ExtensionRuntimeErrorCode | undefined;

  constructor(message: string, errorCode?: ExtensionRuntimeErrorCode) {
    super(message);
    this.name = "ExtensionRuntimeError";
    this.errorCode = errorCode;
  }
}

export function isContentMismatchRuntimeError(error: unknown): boolean {
  return error instanceof ExtensionRuntimeError && error.errorCode === "CONTENT_MISMATCH";
}

export function isPayloadTooLargeRuntimeError(error: unknown): boolean {
  return error instanceof ExtensionRuntimeError && error.errorCode === "PAYLOAD_TOO_LARGE";
}

export function isUpgradeRequiredRuntimeError(error: unknown): boolean {
  return error instanceof ExtensionRuntimeError && error.errorCode === "UPGRADE_REQUIRED";
}

export function isMalformedExtensionVersionRuntimeError(error: unknown): boolean {
  return error instanceof ExtensionRuntimeError && error.errorCode === "MALFORMED_EXTENSION_VERSION";
}

export function isInvalidExtensionMessageRuntimeError(error: unknown): boolean {
  return error instanceof ExtensionRuntimeError && error.errorCode === "INVALID_EXTENSION_MESSAGE";
}

const EXTENSION_CONTEXT_INVALIDATED_PATTERNS = [
  "Extension context invalidated",
  "Could not establish connection. Receiving end does not exist.",
  "The message port closed before a response was received.",
] as const;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isExtensionContextInvalidatedError(error: unknown): boolean {
  const message = errorMessage(error);
  return EXTENSION_CONTEXT_INVALIDATED_PATTERNS.some((pattern) => message.includes(pattern));
}
