import type { z } from "zod";

// ── Claim/result structure (spec §3.2) ───────────────────────────────────

type InvestigatedViewPostOutput = Extract<
  z.infer<typeof import("./schemas.js").viewPostOutputSchema>,
  { investigationState: "INVESTIGATED" }
>;

export type InvestigationClaim = InvestigatedViewPostOutput["claims"][number];

export type InvestigationResult = z.infer<typeof import("./schemas.js").investigationResultSchema>;

export type ClaimId = z.infer<typeof import("./schemas.js").claimIdSchema>;

// ── Platform metadata contracts ───────────────────────────────────────────
export interface PlatformMetadataByPlatform {
  LESSWRONG: Extract<
    z.infer<typeof import("./schemas.js").viewPostInputSchema>,
    { platform: "LESSWRONG" }
  >["metadata"];
  X: Extract<
    z.infer<typeof import("./schemas.js").viewPostInputSchema>,
    { platform: "X" }
  >["metadata"];
  SUBSTACK: Extract<
    z.infer<typeof import("./schemas.js").viewPostInputSchema>,
    { platform: "SUBSTACK" }
  >["metadata"];
  WIKIPEDIA: Extract<
    z.infer<typeof import("./schemas.js").viewPostInputSchema>,
    { platform: "WIKIPEDIA" }
  >["metadata"];
}

// ── Platform adapter (spec §3.8) ──────────────────────────────────────────

export type PlatformContent = Extract<
  z.infer<typeof import("./schemas.js").extensionMessageSchema>,
  { type: "PAGE_CONTENT" }
>["payload"]["content"];

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

export type InvestigationStatusOutput = z.infer<
  typeof import("./schemas.js").investigationStatusOutputSchema
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

export type ExtensionApiOutput<P extends ExtensionApiProcedurePath> =
  ExtensionApiProcedureContract[P]["output"];

// ── Extension cache/status shapes ─────────────────────────────────────────

export type ExtensionPostStatus = z.infer<typeof import("./schemas.js").extensionPostStatusSchema>;

export type ExtensionSkippedStatus = z.infer<
  typeof import("./schemas.js").extensionSkippedStatusSchema
>;

export type ExtensionSkippedReason = ExtensionSkippedStatus["reason"];

export type ExtensionPageStatus = z.infer<typeof import("./schemas.js").extensionPageStatusSchema>;

export type ExtensionRuntimeErrorCode = z.infer<
  typeof import("./schemas.js").extensionRuntimeErrorCodeSchema
>;

// ── Extension message protocol ────────────────────────────────────────────

export type ExtensionMessage = z.infer<typeof import("./schemas.js").extensionMessageSchema>;
