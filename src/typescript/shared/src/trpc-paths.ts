import type { ExtensionApiProcedurePath } from "./types.js";

// Stable procedure identifiers shared by extension and API call sites.
export const EXTENSION_TRPC_PATH = {
  REGISTER_OBSERVED_VERSION: "post.registerObservedVersion",
  RECORD_VIEW_AND_GET_STATUS: "post.recordViewAndGetStatus",
  GET_INVESTIGATION: "post.getInvestigation",
  INVESTIGATE_NOW: "post.investigateNow",
  VALIDATE_SETTINGS: "post.validateSettings",
} as const satisfies Record<string, ExtensionApiProcedurePath>;
