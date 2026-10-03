import type { ExtensionRuntimeErrorCode } from "@openerrata/shared";

/** An error reported across an extension message boundary, with its protocol error code. */
export class ExtensionRuntimeError extends Error {
  readonly errorCode: ExtensionRuntimeErrorCode | undefined;

  constructor(message: string, errorCode?: ExtensionRuntimeErrorCode) {
    super(message);
    this.name = "ExtensionRuntimeError";
    this.errorCode = errorCode;
  }
}

export function hasRuntimeErrorCode(error: unknown, errorCode: ExtensionRuntimeErrorCode): boolean {
  return error instanceof ExtensionRuntimeError && error.errorCode === errorCode;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The calling script belongs to an extension instance that was reloaded,
 * updated or removed: it can never reach the background again.
 */
export function isExtensionContextInvalidatedError(error: unknown): boolean {
  return errorMessage(error).includes("Extension context invalidated");
}

/**
 * `tabs.sendMessage` found no listener in the tab (no content script there).
 * This is an expected outcome of probing a tab, not a fault — every other
 * messaging error is.
 */
export function isNoReceivingEndError(error: unknown): boolean {
  return errorMessage(error).includes("Receiving end does not exist");
}
