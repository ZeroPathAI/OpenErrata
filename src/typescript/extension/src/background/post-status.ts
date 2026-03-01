import { extensionPostStatusSchema } from "@openerrata/shared";
import type {
  ContentProvenance,
  ExtensionPostStatus,
  ExtensionRuntimeErrorCode,
  InvestigationStatusOutput,
  ViewPostInput,
  ViewPostOutput,
} from "@openerrata/shared";
import { ApiClientError } from "./api-client-error.js";

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
  provenance?: ContentProvenance;
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
      priorInvestigationResult: PriorInvestigationResult | null;
    })
  | (PostStatusIdentity & {
      investigationState: "FAILED";
      provenance?: ContentProvenance;
    })
  | (PostStatusIdentity & {
      investigationState: "INVESTIGATED";
      provenance: ContentProvenance;
      claims: NonNullable<InvestigationStatusOutput["claims"]>;
    });

type InvestigationSnapshot = InvestigationStatusOutput | ViewPostOutput;

const fallbackFailureState = { investigationState: "FAILED" as const };
const failureStateByErrorCode = {
  PAYLOAD_TOO_LARGE: fallbackFailureState,
  UPGRADE_REQUIRED: fallbackFailureState,
  MALFORMED_EXTENSION_VERSION: fallbackFailureState,
  INVALID_EXTENSION_MESSAGE: fallbackFailureState,
  UNSUPPORTED_PROTOCOL_VERSION: fallbackFailureState,
} as const satisfies Record<ExtensionRuntimeErrorCode, { investigationState: "FAILED" }>;

function toPostStatusBase(input: PostStatusIdentity): {
  kind: "POST";
  tabSessionId: number;
  platform: ViewPostInput["platform"];
  externalId: string;
  pageUrl: string;
  investigationId?: string;
  provenance?: ContentProvenance;
} {
  const base: {
    kind: "POST";
    tabSessionId: number;
    platform: ViewPostInput["platform"];
    externalId: string;
    pageUrl: string;
    investigationId?: string;
    provenance?: ContentProvenance;
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
  if (input.provenance !== undefined) {
    base.provenance = input.provenance;
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
        claims: null,
        priorInvestigationResult: input.priorInvestigationResult,
      });
    case "INVESTIGATING":
      return extensionPostStatusSchema.parse({
        ...base,
        investigationState: "INVESTIGATING",
        status: input.status,
        provenance: input.provenance,
        claims: null,
        priorInvestigationResult: input.priorInvestigationResult,
      });
    case "FAILED":
      return extensionPostStatusSchema.parse({
        ...base,
        investigationState: "FAILED",
        claims: null,
      });
    case "INVESTIGATED":
      return extensionPostStatusSchema.parse({
        ...base,
        investigationState: "INVESTIGATED",
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
  if (input.provenance !== undefined) {
    identity.provenance = input.provenance;
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

function apiErrorToFailureState(errorCode: ExtensionRuntimeErrorCode | undefined): {
  investigationState: "FAILED";
} {
  if (errorCode === undefined) {
    return fallbackFailureState;
  }

  return failureStateByErrorCode[errorCode];
}
export function apiErrorToPostStatus(input: {
  error: unknown;
  tabSessionId: number;
  platform: ViewPostInput["platform"];
  externalId: string;
  pageUrl: string;
  investigationId?: string;
  provenance?: ContentProvenance;
}): ExtensionPostStatus {
  const errorCode = input.error instanceof ApiClientError ? input.error.errorCode : undefined;
  const statusInput: PostStatusInput = {
    tabSessionId: input.tabSessionId,
    platform: input.platform,
    externalId: input.externalId,
    pageUrl: input.pageUrl,
    ...apiErrorToFailureState(errorCode),
  };
  if (input.investigationId !== undefined) {
    statusInput.investigationId = input.investigationId;
  }
  if (input.provenance !== undefined) {
    statusInput.provenance = input.provenance;
  }
  return createPostStatus(statusInput);
}
