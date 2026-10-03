import type {
  ExtensionPostStatus,
  GetInvestigationOutput,
  InvestigateNowOutput,
  InvestigationId,
  Platform,
  PostId,
  TabSessionId,
  ViewPostOutput,
} from "@openerrata/shared";

/** The page session a post status describes. */
export interface PostPage {
  tabSessionId: TabSessionId;
  platform: Platform;
  externalId: PostId;
  pageUrl: string;
}

type PriorInvestigationResult = Extract<
  ExtensionPostStatus,
  { investigationState: "NOT_INVESTIGATED" }
>["priorInvestigationResult"];

function base(page: PostPage) {
  return {
    kind: "POST" as const,
    tabSessionId: page.tabSessionId,
    platform: page.platform,
    externalId: page.externalId,
    pageUrl: page.pageUrl,
  };
}

/** Status from `recordViewAndGetStatus`. */
export function postStatusFromView(page: PostPage, view: ViewPostOutput): ExtensionPostStatus {
  return { ...base(page), ...view };
}

/**
 * Status from `investigateNow`. Its output carries no progress or interim
 * claims; `prior` keeps the interim claims the page already showed until the
 * first poll reports the investigation's own.
 */
export function postStatusFromInvestigateNow(
  page: PostPage,
  result: InvestigateNowOutput,
  prior: PriorInvestigationResult,
): ExtensionPostStatus {
  switch (result.status) {
    case "COMPLETE":
      return {
        ...base(page),
        investigationState: "INVESTIGATED",
        investigationId: result.investigationId,
        provenance: result.provenance,
        claims: result.claims,
      };
    case "PENDING":
    case "PROCESSING":
      return {
        ...base(page),
        investigationState: "INVESTIGATING",
        investigationId: result.investigationId,
        status: result.status,
        provenance: result.provenance,
        pendingClaims: [],
        confirmedClaims: [],
        priorInvestigationResult: prior,
      };
    case "FAILED":
      return {
        ...base(page),
        investigationState: "FAILED",
        investigationId: result.investigationId,
        provenance: result.provenance,
      };
  }
}

/** Status from polling `getInvestigation` for `investigationId`. */
export function postStatusFromPoll(
  page: PostPage,
  investigationId: InvestigationId,
  output: GetInvestigationOutput,
): ExtensionPostStatus {
  switch (output.investigationState) {
    case "NOT_INVESTIGATED":
      // The API no longer knows the investigation.
      return { ...base(page), ...output };
    case "INVESTIGATING":
    case "FAILED":
      return { ...base(page), investigationId, ...output };
    case "INVESTIGATED": {
      const { checkedAt: _checkedAt, ...investigated } = output;
      return { ...base(page), investigationId, ...investigated };
    }
  }
}

/** The extension could not get a status from the API for this page. */
export function apiErrorPostStatus(page: PostPage): ExtensionPostStatus {
  return { ...base(page), investigationState: "API_ERROR" };
}

/** Interim claims a status shows, to carry over into a newer status of the same page. */
export function priorResultOf(status: ExtensionPostStatus): PriorInvestigationResult {
  return status.investigationState === "INVESTIGATING" ||
    status.investigationState === "NOT_INVESTIGATED"
    ? status.priorInvestigationResult
    : null;
}
