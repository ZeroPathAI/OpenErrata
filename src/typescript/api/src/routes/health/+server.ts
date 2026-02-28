import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { MINIMUM_SUPPORTED_EXTENSION_VERSION } from "$lib/config/env.js";

export const GET: RequestHandler = () => {
  return json({
    status: "ok",
    minimumSupportedExtensionVersion: MINIMUM_SUPPORTED_EXTENSION_VERSION,
  });
};
