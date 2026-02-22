const libpqCompatSslModes = new Set(["allow", "prefer", "require"]);

export function normalizePgConnectionStringForNode(
  databaseUrl: string,
): string {
  const parsed = new URL(databaseUrl);
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode === null) {
    return databaseUrl;
  }

  if (!libpqCompatSslModes.has(sslMode.toLowerCase())) {
    return databaseUrl;
  }

  if (parsed.searchParams.has("uselibpqcompat")) {
    return databaseUrl;
  }

  parsed.searchParams.set("uselibpqcompat", "true");
  return parsed.toString();
}
