import { json } from "@sveltejs/kit";
import { MINIMUM_SUPPORTED_EXTENSION_VERSION } from "$lib/config/env.js";

export function buildHealthResponse(): ReturnType<typeof json> {
  return json({
    status: "ok",
    minimumSupportedExtensionVersion: MINIMUM_SUPPORTED_EXTENSION_VERSION,
  });
}
