/**
 * Per-procedure conversion between the legacy v0 wire shapes
 * (`wire-schemas.ts`) and the current ones. Every extension-facing procedure
 * has an entry, so adding a procedure forces a decision about legacy clients.
 */

import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import {
  batchStatusOutputSchema,
  getInvestigationOutputSchema,
  investigateNowOutputSchema,
  observedImageUrlsFromOccurrences,
  registerObservedVersionOutputSchema,
  settingsValidationOutputSchema,
  viewPostOutputSchema,
  type ExtensionApiProcedureContract,
  type ExtensionApiProcedurePath,
  type ViewPostOutput,
} from "@openerrata/shared";
import {
  legacyBatchStatusInputSchema,
  legacyBatchStatusOutputSchema,
  legacyGetInvestigationInputSchema,
  legacyGetInvestigationOutputSchema,
  legacyInvestigateNowInputSchema,
  legacyInvestigateNowOutputSchema,
  legacyRecordViewAndGetStatusInputSchema,
  legacyRecordViewAndGetStatusOutputSchema,
  legacyRegisterObservedVersionInputSchema,
  legacyRegisterObservedVersionOutputSchema,
  legacyValidateSettingsInputSchema,
  legacyValidateSettingsOutputSchema,
} from "./wire-schemas.js";

type CurrentInput<P extends ExtensionApiProcedurePath> = ExtensionApiProcedureContract[P]["input"];
type CurrentOutput<P extends ExtensionApiProcedurePath> =
  ExtensionApiProcedureContract[P]["output"];

interface LegacyProcedureSpec<P extends ExtensionApiProcedurePath, LegacyInput, LegacyOutput> {
  legacyInputSchema: z.ZodType<LegacyInput>;
  toCurrentInput: (input: LegacyInput) => CurrentInput<P>;
  /** The current output schema, to type the (already validated) procedure result. */
  currentOutputSchema: z.ZodType<CurrentOutput<P>>;
  toLegacyOutput: (output: CurrentOutput<P>) => LegacyOutput;
  legacyOutputSchema: z.ZodType<LegacyOutput>;
}

/** One procedure's legacy conversions, with its wire types erased for the middleware. */
interface LegacyProcedureAdapter<P extends ExtensionApiProcedurePath> {
  /** The procedure adapted; ties each table entry to its key. */
  procedure: P;
  /** Parses a legacy raw input and converts it to the current raw input. */
  toCurrentRawInput: (legacyRawInput: unknown) => unknown;
  /** Converts the current procedure output to a validated legacy output. */
  toLegacyRawOutput: (currentOutput: unknown) => unknown;
}

function defineLegacyProcedure<P extends ExtensionApiProcedurePath, LegacyInput, LegacyOutput>(
  procedure: P,
  spec: LegacyProcedureSpec<P, LegacyInput, LegacyOutput>,
): LegacyProcedureAdapter<P> {
  return {
    procedure,
    toCurrentRawInput(legacyRawInput) {
      const parsed = spec.legacyInputSchema.safeParse(legacyRawInput);
      if (!parsed.success) {
        // Same code tRPC's own input validation uses.
        throw new TRPCError({ code: "BAD_REQUEST", cause: parsed.error });
      }
      return spec.toCurrentInput(parsed.data);
    },
    toLegacyRawOutput(currentOutput) {
      const legacyOutput = spec.toLegacyOutput(spec.currentOutputSchema.parse(currentOutput));
      const validated = spec.legacyOutputSchema.safeParse(legacyOutput);
      if (!validated.success) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Response is not representable in the legacy v0 extension protocol",
          cause: validated.error,
        });
      }
      return validated.data;
    },
  };
}

function unchanged<T>(value: T): T {
  return value;
}

/**
 * The legacy input carried the distinct image URLs alongside the occurrences;
 * the current input derives that list from the occurrences. Every legacy
 * client built both from the same page scan, so dropping the list loses
 * nothing — a list naming images the occurrences do not is not representable.
 */
function withoutObservedImageUrls(
  input: z.output<typeof legacyRegisterObservedVersionInputSchema>,
): CurrentInput<"post.registerObservedVersion"> {
  const { observedImageUrls, ...current } = input;
  const representable = new Set(observedImageUrlsFromOccurrences(input.observedImageOccurrences));
  const unrepresentable = (observedImageUrls ?? []).filter((url) => !representable.has(url));
  if (unrepresentable.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `observedImageUrls lists images missing from observedImageOccurrences: ${unrepresentable.join(", ")}`,
    });
  }
  return current;
}

/**
 * Legacy `recordViewAndGetStatus` reported only finished investigations (no
 * FAILED variant, no investigation id); a client that saw NOT_INVESTIGATED
 * called `investigateNow`, which returns the existing investigation's id and
 * status, and polled from there. Mapping:
 * - INVESTIGATED → INVESTIGATED without the id.
 * - INVESTIGATING → NOT_INVESTIGATED with the same carried-forward claims,
 *   exactly what the legacy API answered for a running investigation. An
 *   INVESTIGATING answer without an id would strand a legacy client: it
 *   neither polls nor calls `investigateNow`.
 * - FAILED → NOT_INVESTIGATED without carried-forward claims (lossy: the legacy
 *   API showed any carried-forward claims here; the current FAILED status does
 *   not compute them). `investigateNow` then reports FAILED to the client.
 * Unknown post versions are not mapped: the legacy API answered
 * NOT_INVESTIGATED, the current one rejects them (BAD_REQUEST), but legacy
 * clients only ask about a version they registered in the same step.
 */
function toLegacyViewStatus(
  output: ViewPostOutput,
): z.output<typeof legacyRecordViewAndGetStatusOutputSchema> {
  switch (output.investigationState) {
    case "NOT_INVESTIGATED":
      return output;
    case "INVESTIGATED": {
      const { investigationId: _investigationId, ...legacy } = output;
      return legacy;
    }
    case "INVESTIGATING":
      return {
        investigationState: "NOT_INVESTIGATED",
        priorInvestigationResult: output.priorInvestigationResult,
      };
    case "FAILED":
      return { investigationState: "NOT_INVESTIGATED", priorInvestigationResult: null };
  }
}

export const LEGACY_PROCEDURE_ADAPTERS: {
  [P in ExtensionApiProcedurePath]: LegacyProcedureAdapter<P>;
} = {
  "post.registerObservedVersion": defineLegacyProcedure("post.registerObservedVersion", {
    legacyInputSchema: legacyRegisterObservedVersionInputSchema,
    toCurrentInput: withoutObservedImageUrls,
    currentOutputSchema: registerObservedVersionOutputSchema,
    toLegacyOutput: unchanged,
    legacyOutputSchema: legacyRegisterObservedVersionOutputSchema,
  }),
  "post.recordViewAndGetStatus": defineLegacyProcedure("post.recordViewAndGetStatus", {
    legacyInputSchema: legacyRecordViewAndGetStatusInputSchema,
    toCurrentInput: unchanged,
    currentOutputSchema: viewPostOutputSchema,
    toLegacyOutput: toLegacyViewStatus,
    legacyOutputSchema: legacyRecordViewAndGetStatusOutputSchema,
  }),
  // The current outputs below are subsets of the legacy ones; the legacy
  // schemas still validate them, so drift in the current protocol fails here
  // rather than in a legacy client.
  "post.getInvestigation": defineLegacyProcedure("post.getInvestigation", {
    legacyInputSchema: legacyGetInvestigationInputSchema,
    toCurrentInput: unchanged,
    currentOutputSchema: getInvestigationOutputSchema,
    toLegacyOutput: unchanged,
    legacyOutputSchema: legacyGetInvestigationOutputSchema,
  }),
  "post.investigateNow": defineLegacyProcedure("post.investigateNow", {
    legacyInputSchema: legacyInvestigateNowInputSchema,
    toCurrentInput: unchanged,
    currentOutputSchema: investigateNowOutputSchema,
    toLegacyOutput: unchanged,
    legacyOutputSchema: legacyInvestigateNowOutputSchema,
  }),
  "post.validateSettings": defineLegacyProcedure("post.validateSettings", {
    legacyInputSchema: legacyValidateSettingsInputSchema,
    toCurrentInput: unchanged,
    currentOutputSchema: settingsValidationOutputSchema,
    toLegacyOutput: unchanged,
    legacyOutputSchema: legacyValidateSettingsOutputSchema,
  }),
  "post.batchStatus": defineLegacyProcedure("post.batchStatus", {
    legacyInputSchema: legacyBatchStatusInputSchema,
    toCurrentInput: unchanged,
    currentOutputSchema: batchStatusOutputSchema,
    toLegacyOutput: unchanged,
    legacyOutputSchema: legacyBatchStatusOutputSchema,
  }),
};
