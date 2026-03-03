import { extensionPostStatusSchema } from "@openerrata/shared";
import type {
  ContentProvenance,
  ExtensionPostStatus,
  InvestigationClaimPayload,
  InvestigationStatusOutput,
  ViewPostInput,
  ViewPostOutput,
} from "@openerrata/shared";
type PriorInvestigationResult = NonNullable<
  Extract<
    InvestigationStatusOutput,
    { investigationState: "NOT_INVESTIGATED" | "INVESTIGATING" }
  >["priorInvestigationResult"]
>;

interface PostStatusIdentity {
  tabSessionId: number;
  platform: ViewPostInput["platform"];
  externalId: string;
  pageUrl: string;
  investigationId?: string;
}

type PostStatusInput =
  | (PostStatusIdentity & {
      investigationState: "NOT_INVESTIGATED";
      priorInvestigationResult: PriorInvestigationResult | null;
    })
  | (PostStatusIdentity & {
      investigationState: "INVESTIGATING";
      status: "PENDING" | "PROCESSING";
      provenance: ContentProvenance;
      pendingClaims: InvestigationClaimPayload[];
      confirmedClaims: InvestigationClaimPayload[];
      priorInvestigationResult: PriorInvestigationResult | null;
    })
  | (PostStatusIdentity & {
      investigationState: "FAILED";
      provenance: ContentProvenance;
    })
  | (PostStatusIdentity & {
      investigationState: "API_ERROR";
    })
  | (PostStatusIdentity & {
      investigationState: "INVESTIGATED";
      provenance: ContentProvenance;
      claims: Extract<InvestigationStatusOutput, { investigationState: "INVESTIGATED" }>["claims"];
    });

type InvestigationSnapshot = InvestigationStatusOutput | ViewPostOutput;

const API_ERROR_INVESTIGATION_STATE = { investigationState: "API_ERROR" as const };

function toPostStatusBase(input: PostStatusIdentity): {
  kind: "POST";
  tabSessionId: number;
  platform: ViewPostInput["platform"];
  externalId: string;
  pageUrl: string;
  investigationId?: string;
} {
  const base: {
    kind: "POST";
    tabSessionId: number;
    platform: ViewPostInput["platform"];
    externalId: string;
    pageUrl: string;
    investigationId?: string;
  } = {
    kind: "POST",
    tabSessionId: input.tabSessionId,
    platform: input.platform,
    externalId: input.externalId,
    pageUrl: input.pageUrl,
  };

  if (input.investigationId !== undefined) {
    base.investigationId = input.investigationId;
  }

  return base;
}

export function createPostStatus(input: PostStatusInput): ExtensionPostStatus {
  const base = toPostStatusBase(input);

  switch (input.investigationState) {
    case "NOT_INVESTIGATED":
      return extensionPostStatusSchema.parse({
        ...base,
        investigationState: "NOT_INVESTIGATED",
        priorInvestigationResult: input.priorInvestigationResult,
      });
    case "INVESTIGATING":
      return extensionPostStatusSchema.parse({
        ...base,
        investigationState: "INVESTIGATING",
        status: input.status,
        provenance: input.provenance,
        pendingClaims: input.pendingClaims,
        confirmedClaims: input.confirmedClaims,
        priorInvestigationResult: input.priorInvestigationResult,
      });
    case "FAILED":
      return extensionPostStatusSchema.parse({
        ...base,
        investigationState: "FAILED",
        provenance: input.provenance,
      });
    case "API_ERROR":
      return extensionPostStatusSchema.parse({
        ...base,
        investigationState: "API_ERROR",
      });
    case "INVESTIGATED":
      return extensionPostStatusSchema.parse({
        ...base,
        investigationState: "INVESTIGATED",
        provenance: input.provenance,
        claims: input.claims,
      });
  }
}

export function createPostStatusFromInvestigation(
  input: PostStatusIdentity & InvestigationSnapshot,
): ExtensionPostStatus {
  const identity: PostStatusIdentity = {
    tabSessionId: input.tabSessionId,
    platform: input.platform,
    externalId: input.externalId,
    pageUrl: input.pageUrl,
  };
  if (input.investigationId !== undefined) {
    identity.investigationId = input.investigationId;
  }

  switch (input.investigationState) {
    case "INVESTIGATED":
      return createPostStatus({
        ...identity,
        investigationState: "INVESTIGATED",
        provenance: input.provenance,
        claims: input.claims,
      });
    case "INVESTIGATING":
      return createPostStatus({
        ...identity,
        investigationState: "INVESTIGATING",
        status: input.status,
        provenance: input.provenance,
        pendingClaims: input.pendingClaims,
        confirmedClaims: input.confirmedClaims,
        priorInvestigationResult: input.priorInvestigationResult ?? null,
      });
    case "FAILED":
      return createPostStatus({
        ...identity,
        investigationState: "FAILED",
        provenance: input.provenance,
      });
    case "NOT_INVESTIGATED":
      return createPostStatus({
        ...identity,
        investigationState: "NOT_INVESTIGATED",
        priorInvestigationResult: input.priorInvestigationResult ?? null,
      });
  }
}

export function apiErrorToPostStatus(input: {
  error: unknown;
  tabSessionId: number;
  platform: ViewPostInput["platform"];
  externalId: string;
  pageUrl: string;
  investigationId?: string;
}): ExtensionPostStatus {
  // API errors (network failures, version mismatches, etc.) produce API_ERROR,
  // not FAILED. FAILED is reserved for investigations that ran and failed on the
  // server, which always have provenance.
  const statusInput: PostStatusInput = {
    tabSessionId: input.tabSessionId,
    platform: input.platform,
    externalId: input.externalId,
    pageUrl: input.pageUrl,
    ...API_ERROR_INVESTIGATION_STATE,
  };
  if (input.investigationId !== undefined) {
    statusInput.investigationId = input.investigationId;
  }
  return createPostStatus(statusInput);
}
