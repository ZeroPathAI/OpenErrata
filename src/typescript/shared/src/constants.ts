import type {
  InvestigationModel,
  InvestigationProvider,
} from "./enums.js";

export const WORD_COUNT_LIMIT = 10000;
export const POLL_INTERVAL_MS = 5000;
export const MAX_INVESTIGATION_RETRIES = 3;
export const MAX_BATCH_STATUS_POSTS = 100;
export const MAX_IMAGES_PER_INVESTIGATION = 10;
export const MAX_IMAGE_BYTES = 20_000_000;

export const DEFAULT_INVESTIGATION_PROVIDER: InvestigationProvider = "OPENAI";
export const DEFAULT_INVESTIGATION_MODEL: InvestigationModel = "OPENAI_GPT_5";
