import type { z } from "zod";

// ── Claim/result structure (spec §3.2) ───────────────────────────────────

type InvestigatedViewPostOutput = Extract<
  z.infer<typeof import("./schemas.js").viewPostOutputSchema>,
  { investigationState: "INVESTIGATED" }
>;

export type InvestigationClaim = InvestigatedViewPostOutput["claims"][number];

export type InvestigationResult = z.infer<typeof import("./schemas.js").investigationResultSchema>;

export type InvestigationClaimPayload = z.infer<
  typeof import("./schemas.js").investigationClaimPayloadSchema
>;

export type ClaimId = z.infer<typeof import("./schemas.js").claimIdSchema>;

export type InvestigationId = z.infer<typeof import("./schemas.js").investigationIdSchema>;

export type PostId = z.infer<typeof import("./schemas/common.js").postIdSchema>;

// ── Platform adapter (spec §3.8) ──────────────────────────────────────────

export type PlatformContent = z.infer<typeof import("./schemas.js").platformContentSchema>;

export type ObservedImageOccurrence = NonNullable<
  z.infer<typeof import("./schemas.js").viewPostInputSchema>["observedImageOccurrences"]
>[number];

// ── tRPC input/output shapes ──────────────────────────────────────────────

export type ViewPostInput = z.infer<typeof import("./schemas.js").viewPostInputSchema>;

export type ViewPostOutput = z.infer<typeof import("./schemas.js").viewPostOutputSchema>;

export type RegisterObservedVersionInput = z.infer<
  typeof import("./schemas.js").registerObservedVersionInputSchema
>;
export type RegisterObservedVersionInputWire = z.input<
  typeof import("./schemas.js").registerObservedVersionInputSchema
>;
export type RegisterObservedVersionOutput = z.infer<
  typeof import("./schemas.js").registerObservedVersionOutputSchema
>;

export type RecordViewAndGetStatusInput = z.infer<
  typeof import("./schemas.js").recordViewAndGetStatusInputSchema
>;
export type RecordViewAndGetStatusInputWire = z.input<
  typeof import("./schemas.js").recordViewAndGetStatusInputSchema
>;

export type GetInvestigationInput = z.infer<
  typeof import("./schemas.js").getInvestigationInputSchema
>;
export type GetInvestigationInputWire = z.input<
  typeof import("./schemas.js").getInvestigationInputSchema
>;

export type GetInvestigationOutput = z.infer<
  typeof import("./schemas.js").getInvestigationOutputSchema
>;

export type InvestigateNowInput = z.infer<typeof import("./schemas.js").investigateNowInputSchema>;
export type InvestigateNowInputWire = z.input<
  typeof import("./schemas.js").investigateNowInputSchema
>;

export type InvestigateNowOutput = z.infer<
  typeof import("./schemas.js").investigateNowOutputSchema
>;

export type SettingsValidationOutput = z.infer<
  typeof import("./schemas.js").settingsValidationOutputSchema
>;

export type BatchStatusInputWire = z.input<typeof import("./schemas.js").batchStatusInputSchema>;
export type BatchStatusOutput = z.infer<typeof import("./schemas.js").batchStatusOutputSchema>;

// ── Extension/API tRPC contract ───────────────────────────────────────────

export interface ExtensionApiProcedureContract {
  "post.registerObservedVersion": {
    kind: "mutation";
    input: RegisterObservedVersionInputWire;
    output: RegisterObservedVersionOutput;
  };
  "post.recordViewAndGetStatus": {
    kind: "mutation";
    input: RecordViewAndGetStatusInputWire;
    output: ViewPostOutput;
  };
  "post.getInvestigation": {
    kind: "query";
    input: GetInvestigationInputWire;
    output: GetInvestigationOutput;
  };
  "post.investigateNow": {
    kind: "mutation";
    input: InvestigateNowInputWire;
    output: InvestigateNowOutput;
  };
  "post.validateSettings": {
    kind: "query";
    // tRPC infers `void` for procedures with no .input() schema.
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    input: void;
    output: SettingsValidationOutput;
  };
  "post.batchStatus": {
    kind: "query";
    input: BatchStatusInputWire;
    output: BatchStatusOutput;
  };
}

export type ExtensionApiProcedurePath = keyof ExtensionApiProcedureContract;

export type ExtensionApiMutationPath = {
  [P in ExtensionApiProcedurePath]: ExtensionApiProcedureContract[P]["kind"] extends "mutation"
    ? P
    : never;
}[ExtensionApiProcedurePath];

export type ExtensionApiQueryPath = {
  [P in ExtensionApiProcedurePath]: ExtensionApiProcedureContract[P]["kind"] extends "query"
    ? P
    : never;
}[ExtensionApiProcedurePath];

export type ExtensionApiInput<P extends ExtensionApiProcedurePath> =
  ExtensionApiProcedureContract[P]["input"];

// ── Extension cache/status shapes ─────────────────────────────────────────

export type ExtensionPostStatus = z.infer<typeof import("./schemas.js").extensionPostStatusSchema>;

export type ExtensionSkippedStatus = Extract<ExtensionPageStatus, { kind: "SKIPPED" }>;

export type ExtensionSkippedReason = ExtensionSkippedStatus["reason"];

export type ExtensionPageStatus = z.infer<typeof import("./schemas.js").extensionPageStatusSchema>;

export type ExtensionRuntimeErrorCode = z.infer<
  typeof import("./schemas.js").extensionRuntimeErrorCodeSchema
>;

export type TabSessionId = z.infer<typeof import("./schemas.js").tabSessionIdSchema>;

// ── Extension message protocol (spec §3.8.1) ──────────────────────────────

type BackgroundRequests = typeof import("./schemas.js").BACKGROUND_REQUESTS;
type ContentRequests = typeof import("./schemas.js").CONTENT_REQUESTS;

export type BackgroundRequestType = keyof BackgroundRequests;
export type BackgroundRequestPayload<T extends BackgroundRequestType> = z.infer<
  BackgroundRequests[T]["payload"]
>;
export type BackgroundResponse<T extends BackgroundRequestType> = z.infer<
  BackgroundRequests[T]["response"]
>;

export type ContentRequestType = keyof ContentRequests;
export type ContentRequestPayload<T extends ContentRequestType> = z.infer<
  ContentRequests[T]["payload"]
>;
export type ContentResponse<T extends ContentRequestType> = z.infer<ContentRequests[T]["response"]>;
