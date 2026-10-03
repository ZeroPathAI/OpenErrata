import {
  claimIdSchema,
  investigationIdSchema,
  tabSessionIdSchema,
  xExternalIdSchema,
  type ExtensionPostStatus,
  type ExtensionSkippedStatus,
  type InvestigationClaim,
  type InvestigationId,
  type TabSessionId,
} from "@openerrata/shared";

/** A deterministic, valid tab session id for test number `n`. */
export function sessionId(n: number): TabSessionId {
  return tabSessionIdSchema.parse(`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`);
}

export function investigationId(value: string): InvestigationId {
  return investigationIdSchema.parse(value);
}

export function claim(text: string, id = "claim-1"): InvestigationClaim {
  return {
    id: claimIdSchema.parse(id),
    text,
    context: text,
    summary: `Summary of ${text}`,
    reasoning: "Reasoning",
    sources: [{ url: "https://example.com/source", title: "Source", snippet: "Snippet" }],
  };
}

const page = {
  kind: "POST" as const,
  platform: "X" as const,
  externalId: xExternalIdSchema.parse("123"),
  pageUrl: "https://x.com/example/status/123",
};

export function notInvestigatedStatus(tabSessionId: TabSessionId): ExtensionPostStatus {
  return {
    ...page,
    tabSessionId,
    investigationState: "NOT_INVESTIGATED",
    priorInvestigationResult: null,
  };
}

export function investigatingStatus(
  tabSessionId: TabSessionId,
  id = investigationId("investigation-1"),
): Extract<ExtensionPostStatus, { investigationState: "INVESTIGATING" }> {
  return {
    ...page,
    tabSessionId,
    investigationState: "INVESTIGATING",
    investigationId: id,
    status: "PENDING",
    provenance: "CLIENT_FALLBACK",
    pendingClaims: [],
    confirmedClaims: [],
    priorInvestigationResult: null,
  };
}

export function investigatedStatus(
  tabSessionId: TabSessionId,
  claims: InvestigationClaim[] = [],
  id = investigationId("investigation-1"),
): ExtensionPostStatus {
  return {
    ...page,
    tabSessionId,
    investigationState: "INVESTIGATED",
    investigationId: id,
    provenance: "CLIENT_FALLBACK",
    claims,
  };
}

export function skippedStatus(tabSessionId: TabSessionId): ExtensionSkippedStatus {
  return {
    kind: "SKIPPED",
    tabSessionId,
    platform: "X",
    pageUrl: page.pageUrl,
    reason: "has_video",
  };
}
