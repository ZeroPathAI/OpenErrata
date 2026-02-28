import { initTRPC } from "@trpc/server";
import {
  extensionRuntimeErrorCodeSchema,
  isNonNullObject,
  parseExtensionVersion,
  type ExtensionRuntimeErrorCode,
} from "@openerrata/shared";
import type { Context } from "./context.js";

function toRuntimeErrorCode(value: unknown): ExtensionRuntimeErrorCode | undefined {
  const parsed = extensionRuntimeErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function toValidExtensionVersion(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || parseExtensionVersion(trimmed) === null) {
    return undefined;
  }
  return trimmed;
}

function toOptionalReceivedExtensionVersion(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return toValidExtensionVersion(value);
}

function toRuntimeErrorMetadata(value: unknown): {
  openerrataCode?: ExtensionRuntimeErrorCode;
  minimumSupportedExtensionVersion?: string;
  receivedExtensionVersion?: string | null;
} {
  if (!isNonNullObject(value)) {
    return {};
  }

  const openerrataCode = toRuntimeErrorCode(value["openerrataCode"]);
  const minimumSupportedExtensionVersion = toValidExtensionVersion(
    value["minimumSupportedExtensionVersion"],
  );
  const receivedExtensionVersion = toOptionalReceivedExtensionVersion(
    value["receivedExtensionVersion"],
  );
  return {
    ...(openerrataCode === undefined ? {} : { openerrataCode }),
    ...(minimumSupportedExtensionVersion === undefined ? {} : { minimumSupportedExtensionVersion }),
    ...(receivedExtensionVersion === undefined ? {} : { receivedExtensionVersion }),
  };
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const metadata = toRuntimeErrorMetadata(error.cause);
    return {
      ...shape,
      data: {
        ...shape.data,
        ...metadata,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
