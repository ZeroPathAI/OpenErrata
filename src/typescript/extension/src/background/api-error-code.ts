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

const MAX_CAUSE_CHAIN_DEPTH = 25;

export function extractApiErrorCode(
  error: unknown,
): ExtensionRuntimeErrorCode | undefined {
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
    if (directCode) return directCode;

    const fromData = isRecord(current["data"])
      ? parseRuntimeErrorCode(current["data"]["openerrataCode"])
      : undefined;
    if (fromData) return fromData;

    const fromShapeData =
      isRecord(current["shape"]) && isRecord(current["shape"]["data"])
        ? parseRuntimeErrorCode(current["shape"]["data"]["openerrataCode"])
        : undefined;
    if (fromShapeData) return fromShapeData;

    current = current["cause"];
  }

  return undefined;
}
