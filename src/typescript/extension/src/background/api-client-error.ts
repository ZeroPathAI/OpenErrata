import type { ExtensionRuntimeErrorCode } from "@openerrata/shared";

export class ApiClientError extends Error {
  readonly errorCode: ExtensionRuntimeErrorCode | undefined;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      errorCode?: ExtensionRuntimeErrorCode;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ApiClientError";
    this.errorCode = options?.errorCode;
  }
}
