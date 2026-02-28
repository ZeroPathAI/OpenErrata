import {
  extensionRuntimeErrorCodeSchema,
  isNonNullObject,
  parseExtensionVersion,
  trimToOptionalNonEmpty,
  type ExtensionRuntimeErrorCode,
} from "@openerrata/shared";

function parseRuntimeErrorCode(value: unknown): ExtensionRuntimeErrorCode | undefined {
  const parsed = extensionRuntimeErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const PAYLOAD_TOO_LARGE_HTTP_STATUS = 413;
const MAX_CAUSE_CHAIN_DEPTH = 25;

function walkCauseChain<T>(
  error: unknown,
  extractor: (current: Record<string, unknown>) => T | undefined,
): T | undefined {
  let current: unknown = error;
  const seen = new Set<object>();

  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH; depth += 1) {
    if (!isNonNullObject(current)) {
      return undefined;
    }

    if (seen.has(current)) {
      return undefined;
    }
    seen.add(current);

    const extracted = extractor(current);
    if (extracted !== undefined) {
      return extracted;
    }

    current = current["cause"];
  }

  return undefined;
}

function parseHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function runtimeErrorCodeFromHttpStatus(status: unknown): ExtensionRuntimeErrorCode | undefined {
  return parseHttpStatus(status) === PAYLOAD_TOO_LARGE_HTTP_STATUS
    ? "PAYLOAD_TOO_LARGE"
    : undefined;
}

function parseMinimumSupportedExtensionVersion(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = trimToOptionalNonEmpty(value);
  if (trimmed === undefined || parseExtensionVersion(trimmed) === null) {
    return undefined;
  }
  return trimmed;
}

export function extractApiErrorCode(error: unknown): ExtensionRuntimeErrorCode | undefined {
  return walkCauseChain(error, (current) => {
    const directCode = parseRuntimeErrorCode(current["errorCode"]);
    if (directCode !== undefined) return directCode;

    const fromData = isNonNullObject(current["data"])
      ? parseRuntimeErrorCode(current["data"]["openerrataCode"])
      : undefined;
    if (fromData !== undefined) return fromData;

    const fromShapeData =
      isNonNullObject(current["shape"]) && isNonNullObject(current["shape"]["data"])
        ? parseRuntimeErrorCode(current["shape"]["data"]["openerrataCode"])
        : undefined;
    if (fromShapeData !== undefined) return fromShapeData;

    const fromHttpStatus =
      runtimeErrorCodeFromHttpStatus(current["httpStatus"]) ??
      (isNonNullObject(current["data"])
        ? runtimeErrorCodeFromHttpStatus(current["data"]["httpStatus"])
        : undefined) ??
      (isNonNullObject(current["shape"]) && isNonNullObject(current["shape"]["data"])
        ? runtimeErrorCodeFromHttpStatus(current["shape"]["data"]["httpStatus"])
        : undefined) ??
      (isNonNullObject(current["meta"]) && isNonNullObject(current["meta"]["response"])
        ? runtimeErrorCodeFromHttpStatus(current["meta"]["response"]["status"])
        : undefined);
    if (fromHttpStatus !== undefined) return fromHttpStatus;

    return undefined;
  });
}

export function extractMinimumSupportedExtensionVersion(error: unknown): string | undefined {
  return walkCauseChain(error, (current) => {
    const direct = parseMinimumSupportedExtensionVersion(
      current["minimumSupportedExtensionVersion"],
    );
    if (direct !== undefined) {
      return direct;
    }

    const fromData = isNonNullObject(current["data"])
      ? parseMinimumSupportedExtensionVersion(current["data"]["minimumSupportedExtensionVersion"])
      : undefined;
    if (fromData !== undefined) {
      return fromData;
    }

    const fromShapeData =
      isNonNullObject(current["shape"]) && isNonNullObject(current["shape"]["data"])
        ? parseMinimumSupportedExtensionVersion(
            current["shape"]["data"]["minimumSupportedExtensionVersion"],
          )
        : undefined;
    if (fromShapeData !== undefined) {
      return fromShapeData;
    }

    return undefined;
  });
}
