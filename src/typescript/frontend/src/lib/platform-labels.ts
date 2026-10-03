import type { Platform } from "@openerrata/shared";

// Type-only import: pages must not pull the shared schema barrel into the client bundle.
export const PLATFORM_LABELS = {
  LESSWRONG: "LessWrong",
  X: "X",
  SUBSTACK: "Substack",
  WIKIPEDIA: "Wikipedia",
} as const satisfies Record<Platform, string>;
