import type { InvestigationProvider } from "./enums.js";

export const WORD_COUNT_LIMIT = 10000;
export const POLL_INTERVAL_MS = 5000;
export const MAX_BATCH_STATUS_POSTS = 100;
export const MAX_IMAGES_PER_INVESTIGATION = 10;
export const MAX_IMAGE_BYTES = 20_000_000;
export const MAX_OBSERVED_IMAGE_OCCURRENCES = 256;
export const MAX_OBSERVED_CONTENT_TEXT_CHARS = 500_000;
// Keep observed content comfortably below transport-level request size limits.
export const MAX_OBSERVED_CONTENT_TEXT_UTF8_BYTES = 500_000;
export const OPENAI_KEY_VALIDATION_TIMEOUT_MS = 8_000;

export const DEFAULT_INVESTIGATION_PROVIDER: InvestigationProvider = "OPENAI";
