import type {
  ExtensionPostStatus,
  ExtensionRuntimeErrorCode,
  GetInvestigationOutput,
  InvestigationStatusOutput,
  ViewPostInput,
  ViewPostOutput,
} from "@openerrata/shared";

type PostStatusInput = {
  tabSessionId: number;
  platform: ViewPostInput["platform"];
  externalId: string;
  pageUrl: string;
  investigationId?: string;
  investigationState: ExtensionPostStatus["investigationState"];
  status?: GetInvestigationOutput["status"];
  provenance?: ViewPostOutput["provenance"];
  claims: InvestigationStatusOutput["claims"];
};

function toPostStatusBase(input: PostStatusInput): {
  kind: "POST";
  tabSessionId: number;
  platform: ViewPostInput["platform"];
  externalId: string;
  pageUrl: string;
  investigationId?: string;
  provenance?: ViewPostOutput["provenance"];
} {
  return {
    kind: "POST",
    tabSessionId: input.tabSessionId,
    platform: input.platform,
    externalId: input.externalId,
    pageUrl: input.pageUrl,
    ...(input.investigationId === undefined
      ? {}
      : { investigationId: input.investigationId }),
    ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
  };
}

export function createPostStatus(input: PostStatusInput): ExtensionPostStatus {
  const base = toPostStatusBase(input);

  if (input.investigationState === "NOT_INVESTIGATED") {
    if (input.status !== undefined) {
      throw new Error("NOT_INVESTIGATED state must not include status");
    }
    return {
      ...base,
      investigationState: "NOT_INVESTIGATED",
      claims: null,
    };
  }

  if (input.investigationState === "INVESTIGATING") {
    if (input.status !== "PENDING" && input.status !== "PROCESSING") {
      throw new Error("INVESTIGATING state must include PENDING or PROCESSING status");
    }
    return {
      ...base,
      investigationState: "INVESTIGATING",
      status: input.status,
      claims: null,
    };
  }

  if (input.investigationState === "FAILED") {
    return {
      ...base,
      investigationState: "FAILED",
      status: "FAILED",
      claims: null,
    };
  }

  if (input.investigationState === "CONTENT_MISMATCH") {
    if (input.status !== undefined) {
      throw new Error("CONTENT_MISMATCH state must not include status");
    }
    return {
      ...base,
      investigationState: "CONTENT_MISMATCH",
      claims: null,
    };
  }

  if (input.status !== undefined && input.status !== "COMPLETE") {
    throw new Error("INVESTIGATED state must only include COMPLETE status");
  }

  return {
    ...base,
    investigationState: "INVESTIGATED",
    ...(input.status === undefined ? {} : { status: input.status }),
    claims: input.claims ?? [],
  };
}

export function viewPostErrorToFailureState(
  errorCode: ExtensionRuntimeErrorCode | undefined,
): Pick<PostStatusInput, "investigationState" | "status" | "claims"> {
  if (errorCode === "CONTENT_MISMATCH") {
    return {
      investigationState: "CONTENT_MISMATCH",
      status: undefined,
      claims: null,
    };
  }
  return {
    investigationState: "FAILED",
    status: "FAILED",
    claims: null,
  };
}
