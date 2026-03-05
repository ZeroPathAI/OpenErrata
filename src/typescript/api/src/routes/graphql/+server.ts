import type { RequestHandler } from "./$types";
import { handlePublicGraphqlRequest } from "$lib/graphql/handler.js";

export const POST: RequestHandler = async ({ request }) => {
  return handlePublicGraphqlRequest(request);
};
