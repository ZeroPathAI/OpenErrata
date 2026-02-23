import type { ExtensionRuntimeErrorCode } from "@openerrata/shared";

export class ExtensionRuntimeError extends Error {
  readonly errorCode: ExtensionRuntimeErrorCode | undefined;

  constructor(message: string, errorCode?: ExtensionRuntimeErrorCode) {
    super(message);
    this.name = "ExtensionRuntimeError";
    this.errorCode = errorCode;
  }
}

export function isContentMismatchRuntimeError(error: unknown): boolean {
  return (
    error instanceof ExtensionRuntimeError &&
    error.errorCode === "CONTENT_MISMATCH"
  );
}
