import { z } from "zod";
import type { PublicQuery } from "../public-queries.js";

/**
 * The public API was unreachable or answered outside the public contract
 * (HTTP error, GraphQL errors, or data that fails the shared schemas).
 */
export class PublicApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PublicApiError";
  }
}

interface PublicApiTransport {
  /** Origin (optionally with a path prefix) of the OpenErrata API. */
  baseUrl: string;
  fetch: typeof globalThis.fetch;
}

const graphqlResponseSchema = z.object({
  data: z.unknown(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const MAX_LOGGED_ERROR_BODY_CHARS = 500;

function graphqlEndpoint(baseUrl: string): URL {
  return new URL("graphql", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

/**
 * POST `query` to the API's `/graphql` endpoint and return its data parsed with
 * the query's shared response schema. Throws `PublicApiError` for every failure
 * of the API; invalid `variables` are a caller bug and throw a ZodError.
 */
export async function runPublicQuery<TVariables extends z.ZodType, TData extends z.ZodType>(
  transport: PublicApiTransport,
  query: PublicQuery<TVariables, TData>,
  variables: z.input<TVariables>,
): Promise<z.output<TData>> {
  const body = JSON.stringify({
    query: query.document,
    variables: query.variablesSchema.parse(variables),
  });

  let response: Response;
  try {
    response = await transport.fetch(graphqlEndpoint(transport.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
    });
  } catch (cause) {
    throw new PublicApiError("Public API request failed", { cause });
  }

  if (!response.ok) {
    const text = await response.text();
    throw new PublicApiError(
      `Public API responded ${response.status.toString()} ${response.statusText}: ${text.slice(0, MAX_LOGGED_ERROR_BODY_CHARS)}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new PublicApiError("Public API returned a non-JSON body", { cause });
  }

  const envelope = graphqlResponseSchema.safeParse(payload);
  if (!envelope.success) {
    throw new PublicApiError("Public API returned a malformed GraphQL response", {
      cause: envelope.error,
    });
  }
  const { errors } = envelope.data;
  if (errors !== undefined && errors.length > 0) {
    throw new PublicApiError(`GraphQL errors: ${errors.map((e) => e.message).join("; ")}`);
  }

  const data = query.dataSchema.safeParse(envelope.data.data);
  if (!data.success) {
    throw new PublicApiError(
      `Public API response violates the public contract:\n${z.prettifyError(data.error)}`,
    );
  }
  return data.data;
}
