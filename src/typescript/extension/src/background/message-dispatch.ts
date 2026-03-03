import type { GetInvestigationOutput, InvestigationStatusOutput } from "@openerrata/shared";

const BACKGROUND_MESSAGE_TYPES = new Set([
  "PAGE_CONTENT",
  "PAGE_SKIPPED",
  "PAGE_RESET",
  "GET_STATUS",
  "INVESTIGATE_NOW",
  "GET_CACHED",
]);

export type BackgroundMessageType =
  | "PAGE_CONTENT"
  | "PAGE_SKIPPED"
  | "PAGE_RESET"
  | "GET_STATUS"
  | "INVESTIGATE_NOW"
  | "GET_CACHED";

export function isBackgroundMessageType(type: string): type is BackgroundMessageType {
  return BACKGROUND_MESSAGE_TYPES.has(type);
}

export function toInvestigationStatusSnapshot(
  output: GetInvestigationOutput,
): InvestigationStatusOutput {
  const { checkedAt: _checkedAt, ...snapshot } = output;
  return snapshot;
}
