import {
  extensionRuntimeErrorCodeSchema,
  type ExtensionRuntimeErrorCode,
} from "@openerrata/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRuntimeErrorCode(value: unknown): ExtensionRuntimeErrorCode | undefined {
  const parsed = extensionRuntimeErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const PAYLOAD_TOO_LARGE_HTTP_STATUS = 413;
const MAX_CAUSE_CHAIN_DEPTH = 25;

function parseHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function runtimeErrorCodeFromHttpStatus(status: unknown): ExtensionRuntimeErrorCode | undefined {
  return parseHttpStatus(status) === PAYLOAD_TOO_LARGE_HTTP_STATUS
    ? "PAYLOAD_TOO_LARGE"
    : undefined;
}

export function extractApiErrorCode(error: unknown): ExtensionRuntimeErrorCode | undefined {
  let current: unknown = error;
  const seen = new Set<object>();

  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH; depth += 1) {
    if (!isRecord(current)) {
      return undefined;
    }

    if (seen.has(current)) {
      return undefined;
    }
    seen.add(current);

    const directCode = parseRuntimeErrorCode(current["errorCode"]);
    if (directCode !== undefined) return directCode;

    const fromData = isRecord(current["data"])
      ? parseRuntimeErrorCode(current["data"]["openerrataCode"])
      : undefined;
    if (fromData !== undefined) return fromData;

    const fromShapeData =
      isRecord(current["shape"]) && isRecord(current["shape"]["data"])
        ? parseRuntimeErrorCode(current["shape"]["data"]["openerrataCode"])
        : undefined;
    if (fromShapeData !== undefined) return fromShapeData;

    const fromHttpStatus =
      runtimeErrorCodeFromHttpStatus(current["httpStatus"]) ??
      (isRecord(current["data"])
        ? runtimeErrorCodeFromHttpStatus(current["data"]["httpStatus"])
        : undefined) ??
      (isRecord(current["shape"]) && isRecord(current["shape"]["data"])
        ? runtimeErrorCodeFromHttpStatus(current["shape"]["data"]["httpStatus"])
        : undefined) ??
      (isRecord(current["meta"]) && isRecord(current["meta"]["response"])
        ? runtimeErrorCodeFromHttpStatus(current["meta"]["response"]["status"])
        : undefined);
    if (fromHttpStatus !== undefined) return fromHttpStatus;

    current = current["cause"];
  }

  return undefined;
}
