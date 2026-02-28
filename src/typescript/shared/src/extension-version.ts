const MAX_EXTENSION_VERSION_SEGMENTS = 4;
const MAX_EXTENSION_VERSION_COMPONENT = 65_535;
const VERSION_COMPONENT_INDICES = [0, 1, 2, 3] as const;

type ParsedExtensionVersion = readonly [number, number, number, number];

function parseVersionComponent(rawValue: string): number | null {
  if (!/^\d+$/.test(rawValue)) {
    return null;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_EXTENSION_VERSION_COMPONENT) {
    return null;
  }

  return parsed;
}

export function parseExtensionVersion(version: string): ParsedExtensionVersion | null {
  const trimmed = version.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const rawSegments = trimmed.split(".");
  if (rawSegments.length > MAX_EXTENSION_VERSION_SEGMENTS) {
    return null;
  }

  const parsed: number[] = [];
  for (const rawSegment of rawSegments) {
    const parsedComponent = parseVersionComponent(rawSegment);
    if (parsedComponent === null) {
      return null;
    }
    parsed.push(parsedComponent);
  }

  // Input validation guarantees 1–4 segments; pad missing segments to zero.
  const major = parsed[0];
  if (major === undefined) {
    return null;
  }
  return [major, parsed[1] ?? 0, parsed[2] ?? 0, parsed[3] ?? 0];
}

export function compareExtensionVersions(left: string, right: string): -1 | 0 | 1 | null {
  const parsedLeft = parseExtensionVersion(left);
  const parsedRight = parseExtensionVersion(right);
  if (parsedLeft === null || parsedRight === null) {
    return null;
  }

  for (const index of VERSION_COMPONENT_INDICES) {
    const leftValue = parsedLeft[index];
    const rightValue = parsedRight[index];
    if (leftValue > rightValue) {
      return 1;
    }
    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

export function isExtensionVersionAtLeast(version: string, minimumVersion: string): boolean | null {
  const comparison = compareExtensionVersions(version, minimumVersion);
  if (comparison === null) {
    return null;
  }

  return comparison >= 0;
}
