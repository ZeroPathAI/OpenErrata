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

export const POST: RequestHandler = async ({ request }) => yoga.fetch(request);
