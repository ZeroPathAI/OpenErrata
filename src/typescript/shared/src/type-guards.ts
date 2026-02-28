/**
 * Narrows `unknown` to `Record<string, unknown>` after confirming the value is
 * a non-null, non-array object. Useful for safely replacing `value as
 * Record<string, unknown>` casts after manual `typeof` / null checks.
 */
export function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
