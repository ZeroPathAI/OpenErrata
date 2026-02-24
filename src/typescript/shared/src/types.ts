import type { z } from "zod";

// ── LLM output structure (spec §3.2) ─────────────────────────────────────

export type InvestigationClaim = z.infer<
  typeof import("./schemas.js").investigationClaimSchema
>;

export type InvestigationResult = z.infer<
  typeof import("./schemas.js").investigationResultSchema
>;

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
}

// ── Platform adapter (spec §3.8) ──────────────────────────────────────────

export type PlatformContent = z.infer<typeof import("./schemas.js").platformContentSchema>;

// ── tRPC input/output shapes ──────────────────────────────────────────────

export type ViewPostInput = z.infer<typeof import("./schemas.js").viewPostInputSchema>;

export type ViewPostOutput = z.infer<typeof import("./schemas.js").viewPostOutputSchema>;

export type InvestigationStatusOutput = z.infer<
  typeof import("./schemas.js").investigationStatusOutputSchema
>;

export type GetInvestigationInput = z.infer<
  typeof import("./schemas.js").getInvestigationInputSchema
>;

export type GetInvestigationOutput = z.infer<
  typeof import("./schemas.js").getInvestigationOutputSchema
>;

export type InvestigateNowOutput = z.infer<
  typeof import("./schemas.js").investigateNowOutputSchema
>;

export type SettingsValidationOutput = z.infer<
  typeof import("./schemas.js").settingsValidationOutputSchema
>;

// ── Extension/API tRPC contract ───────────────────────────────────────────

export interface ExtensionApiProcedureContract {
  "post.viewPost": {
    kind: "mutation";
    input: ViewPostInput;
    output: ViewPostOutput;
  };
  "post.getInvestigation": {
    kind: "query";
    input: GetInvestigationInput;
    output: GetInvestigationOutput;
  };
  "post.investigateNow": {
    kind: "mutation";
    input: ViewPostInput;
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

export type ExtensionPostStatus = z.infer<
  typeof import("./schemas.js").extensionPostStatusSchema
>;

export type ExtensionSkippedStatus = z.infer<
  typeof import("./schemas.js").extensionSkippedStatusSchema
>;

export type ExtensionSkippedReason = ExtensionSkippedStatus["reason"];

export type ExtensionPageStatus = z.infer<
  typeof import("./schemas.js").extensionPageStatusSchema
>;

export type ExtensionRuntimeErrorCode = z.infer<
  typeof import("./schemas.js").extensionRuntimeErrorCodeSchema
>;

// ── Extension message protocol ────────────────────────────────────────────

export type ExtensionMessage = z.infer<typeof import("./schemas.js").extensionMessageSchema>;
