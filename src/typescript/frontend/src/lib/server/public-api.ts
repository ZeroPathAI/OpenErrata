import { env } from "$env/dynamic/private";
import { error } from "@sveltejs/kit";
import type { z } from "zod";
import type { PublicQuery } from "$lib/public-queries";
import { PublicApiError, runPublicQuery } from "$lib/server/public-api-client";

/**
 * Origin of the OpenErrata API whose public GraphQL endpoint backs every page.
 * `hooks.server.ts` calls this at startup so a misconfigured server never boots.
 */
export function publicApiBaseUrl(): string {
  const value = env["API_BASE_URL"];
  if (value === undefined || value.length === 0) {
    throw new Error("API_BASE_URL environment variable is required");
  }
  const { protocol } = new URL(value);
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`API_BASE_URL must be an http(s) URL, got protocol ${protocol}`);
  }
  return value;
}

/**
 * Run a public query for a page load. An unavailable API or a response outside
 * the public contract becomes a 502 page; details go to the server log only.
 */
export async function loadPublicQuery<TVariables extends z.ZodType, TData extends z.ZodType>(
  fetch: typeof globalThis.fetch,
  query: PublicQuery<TVariables, TData>,
  variables: z.input<TVariables>,
): Promise<z.output<TData>> {
  try {
    return await runPublicQuery({ baseUrl: publicApiBaseUrl(), fetch }, query, variables);
  } catch (cause) {
    if (!(cause instanceof PublicApiError)) {
      throw cause;
    }
    console.error(cause);
    error(502, "The OpenErrata API is unavailable right now. Please try again later.");
  }
}
