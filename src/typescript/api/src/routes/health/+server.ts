import type { RequestHandler } from "./$types";
import { buildHealthResponse } from "$lib/services/health.js";

export const GET: RequestHandler = () => {
  return buildHealthResponse();
};
