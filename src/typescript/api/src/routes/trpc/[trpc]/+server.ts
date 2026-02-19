import { appRouter } from "$lib/trpc/router.js";
import { createContext } from "$lib/trpc/context.js";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { RequestHandler } from "./$types";

const handler: RequestHandler = async (event) =>
  fetchRequestHandler({
    endpoint: "/trpc",
    req: event.request,
    router: appRouter,
    createContext: async () => createContext(event),
    onError({ path, error }) {
      console.error(`[tRPC] path=${path ?? "unknown"} error=`, error);
    },
  });

export const GET = handler;
export const POST = handler;
