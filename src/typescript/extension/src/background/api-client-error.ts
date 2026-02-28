import type { ExtensionRuntimeErrorCode } from "@openerrata/shared";

export class ApiClientError extends Error {
  readonly errorCode: ExtensionRuntimeErrorCode | undefined;
  readonly minimumSupportedExtensionVersion: string | undefined;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      errorCode?: ExtensionRuntimeErrorCode;
      minimumSupportedExtensionVersion?: string;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ApiClientError";
    this.errorCode = options?.errorCode;
    this.minimumSupportedExtensionVersion = options?.minimumSupportedExtensionVersion;
  }
}
