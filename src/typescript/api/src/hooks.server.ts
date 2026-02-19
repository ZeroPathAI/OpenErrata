import { runStartupChecks } from "$lib/config/startup.js";
import type { Handle } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";

const startupChecks = runStartupChecks("api").catch((error) => {
  console.error("[startup:api] Startup checks failed", error);
  throw error;
});

const startupGuard: Handle = async ({ event, resolve }) => {
  await startupChecks;
  return resolve(event);
};

const cors: Handle = async ({ event, resolve }) => {
  // Handle CORS preflight
  if (event.request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, x-api-key, x-openai-api-key, x-truesight-signature",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const response = await resolve(event);

  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, x-api-key, x-openai-api-key, x-truesight-signature",
  );

  return response;
};

export const handle: Handle = sequence(startupGuard, cors);
