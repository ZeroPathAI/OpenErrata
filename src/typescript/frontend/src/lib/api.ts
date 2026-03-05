function getApiBaseUrl(): string {
  const url = process.env["API_BASE_URL"];
  if (url === undefined || url.length === 0) {
    throw new Error("API_BASE_URL environment variable is required");
  }
  return url;
}

/**
 * Send a GraphQL query to the API server and return the typed `data` field.
 *
 * This is a system boundary: the response body is validated structurally
 * (object with a `data` key, optional `errors` array) and then cast to `T`.
 * Callers trust that the GraphQL schema matches the TypeScript interface.
 */
export async function graphqlQuery<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const body: unknown = await response.json();

  if (typeof body !== "object" || body === null || !("data" in body)) {
    throw new Error("GraphQL response missing 'data' field");
  }

  const record = body as Record<string, unknown>;

  if ("errors" in body && Array.isArray(record["errors"]) && record["errors"].length > 0) {
    const errors = record["errors"] as { message: string }[];
    throw new Error(`GraphQL error: ${errors.map((e) => e.message).join(", ")}`);
  }

  return record["data"] as T;
}
