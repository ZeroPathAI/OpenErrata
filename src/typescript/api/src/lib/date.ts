export function toDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid ISO timestamp: ${value}`);
  }
  return parsed;
}

export function toOptionalDate(
  value: string | null | undefined,
  options?: { strict?: boolean },
): Date | null {
  if (value == null) return null;
  if (options?.strict === true) return toDate(value);
  return new Date(value);
}
