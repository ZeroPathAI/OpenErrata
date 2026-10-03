import type { ServerInit } from "@sveltejs/kit";
import { publicApiBaseUrl } from "$lib/server/public-api";

// Fail at startup rather than on the first request when API_BASE_URL is unusable.
export const init: ServerInit = () => {
  publicApiBaseUrl();
};
