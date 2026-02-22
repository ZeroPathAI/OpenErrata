import { runStartupChecks } from "$lib/config/startup.js";
import type { Handle } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";

// Deferred to first request so that `vite build` can compile the server bundle
// without requiring runtime secrets or a database connection.
let startupChecks: Promise<void> | undefined;

function runApiStartupChecksOnce(): Promise<void> {
  if (startupChecks) {
    return startupChecks;
  }

  startupChecks = runStartupChecks("api").catch((error: unknown) => {
    // Startup checks can fail transiently (e.g. DB unavailable briefly). Clear
    // the cached rejection so the next request can retry.
    startupChecks = undefined;
    console.error("[startup:api] Startup checks failed", error);
    throw error;
  });

  return startupChecks;
}

const startupGuard: Handle = async ({ event, resolve }) => {
  await runApiStartupChecksOnce();
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
          "Content-Type, x-api-key, x-openai-api-key, x-openerrata-signature",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const response = await resolve(event);

  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, x-api-key, x-openai-api-key, x-openerrata-signature",
  );

  return response;
};

export const handle: Handle = sequence(startupGuard, cors);
