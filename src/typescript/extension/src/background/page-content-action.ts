import type { ExtensionPostStatus } from "@openerrata/shared";

type PageContentPostCacheAction = "RESUME_POLLING" | "AUTO_INVESTIGATE" | "STOP_POLLING";

export function decidePageContentPostCacheAction(input: {
  status: Pick<ExtensionPostStatus, "investigationState" | "investigationId">;
  shouldAutoInvestigate: boolean;
}): PageContentPostCacheAction {
  if (
    input.status.investigationState === "INVESTIGATING" &&
    input.status.investigationId !== undefined
  ) {
    return "RESUME_POLLING";
  }
  if (input.shouldAutoInvestigate) {
    return "AUTO_INVESTIGATE";
  }
  return "STOP_POLLING";
}
