export const PLATFORM_VALUES = ["LESSWRONG", "X", "SUBSTACK", "WIKIPEDIA"] as const;
export type Platform = (typeof PLATFORM_VALUES)[number];

export const CHECK_STATUS_VALUES = ["PENDING", "PROCESSING", "COMPLETE", "FAILED"] as const;
export type CheckStatus = (typeof CHECK_STATUS_VALUES)[number];

export const CONTENT_PROVENANCE_VALUES = ["SERVER_VERIFIED", "CLIENT_FALLBACK"] as const;
export type ContentProvenance = (typeof CONTENT_PROVENANCE_VALUES)[number];

export const INVESTIGATION_PROVIDER_VALUES = ["OPENAI", "ANTHROPIC"] as const;
export type InvestigationProvider = (typeof INVESTIGATION_PROVIDER_VALUES)[number];

export const INVESTIGATION_MODEL_VALUES = [
  "OPENAI_GPT_5",
  "OPENAI_GPT_5_MINI",
  "ANTHROPIC_CLAUDE_SONNET",
  "ANTHROPIC_CLAUDE_OPUS",
] as const;
export type InvestigationModel = (typeof INVESTIGATION_MODEL_VALUES)[number];
