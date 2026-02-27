import { getPrisma } from "$lib/db/client.js";
import { publicGraphqlSchema, type PublicGraphqlContext } from "$lib/graphql/public-schema.js";
import { createYoga } from "graphql-yoga";
import type { RequestHandler } from "./$types";

const yoga = createYoga<PublicGraphqlContext>({
  schema: publicGraphqlSchema,
  graphqlEndpoint: "/graphql",
  logging: false,
  context: () => ({ prisma: getPrisma() }),
});

type ResponseLike = {
  body: BodyInit | null;
  status: number;
  statusText: string;
  headers: HeadersInit;
};

function toNativeResponse(response: ResponseLike): Response {
  if (response instanceof Response) {
    return response;
  }

  // SvelteKit route handlers must return a native Response instance.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const POST: RequestHandler = async ({ request }) => {
  const response = (await yoga.fetch(request)) as ResponseLike;
  return toNativeResponse(response);
};
