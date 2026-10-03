import type { FunctionTool } from "openai/resources/responses/responses";
import { z } from "zod";
import {
  investigationClaimPayloadSchema,
  type InvestigationClaimPayload,
} from "@openerrata/shared";

export const SUBMIT_CORRECTION_TOOL_NAME = "submit_correction";
export const RETAIN_CORRECTION_TOOL_NAME = "retain_correction";

/**
 * A claim tool call's arguments, checked against the tool's schema. Invalid
 * arguments are reported back to the model (as the call's output) so it can
 * correct and resubmit within the same run.
 */
type ClaimToolArguments<T> = { kind: "valid"; value: T } | { kind: "invalid"; error: string };

/**
 * JSON Schema for a function tool's parameters under OpenAI strict mode, which
 * accepts only a subset of JSON Schema. It rejects `minLength` and
 * `format: "uri"`, which Zod emits for the shared claim schema's non-empty
 * strings and URLs, so those keywords are left out of the provider-facing
 * schema; parsing the arguments with the full Zod schema enforces them.
 */
function toStrictModeParameters(schema: z.ZodObject): Record<string, unknown> {
  // Spread to a plain object: Zod attaches non-enumerable Standard Schema hooks.
  return {
    ...z.toJSONSchema(schema, {
      target: "draft-07",
      override: ({ jsonSchema }) => {
        delete jsonSchema.minLength;
        if (jsonSchema.format === "uri") {
          delete jsonSchema.format;
        }
      },
    }),
  };
}

function parseToolArguments<T>(schema: z.ZodType<T>, argumentsJson: string): ClaimToolArguments<T> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(argumentsJson);
  } catch {
    return { kind: "invalid", error: "Arguments are not valid JSON" };
  }
  const parsed = schema.safeParse(decoded);
  return parsed.success
    ? { kind: "valid", value: parsed.data }
    : { kind: "invalid", error: z.prettifyError(parsed.error) };
}

// ── submit_correction ───────────────────────────────────────────────────────

const claimShape = investigationClaimPayloadSchema.shape;
const claimSourceSchema = claimShape.sources.element;

// The shared claim payload schema with model-facing field descriptions.
// `.describe()` only attaches metadata: the tool advertises exactly the shape
// that `parseSubmitCorrectionArguments` validates with the shared schema.
const submitCorrectionParametersSchema = investigationClaimPayloadSchema.extend({
  text: claimShape.text.describe("The exact text of the incorrect claim."),
  context: claimShape.context.describe(
    "Surrounding context that disambiguates the claim location.",
  ),
  summary: claimShape.summary.describe("A one-sentence summary of what is incorrect and why."),
  reasoning: claimShape.reasoning.describe(
    "Detailed reasoning with evidence for why the claim is incorrect.",
  ),
  sources: z
    .array(
      claimSourceSchema.extend({
        url: claimSourceSchema.shape.url.describe("Source URL (absolute http/https)."),
        title: claimSourceSchema.shape.title.describe("Title of the source."),
        snippet: claimSourceSchema.shape.snippet.describe("Relevant snippet from the source."),
      }),
    )
    .min(1)
    .describe("At least one supporting source."),
});

/** Submits one correction; called as the model finds each incorrect claim. */
export const submitCorrectionToolDefinition: FunctionTool = {
  type: "function",
  name: SUBMIT_CORRECTION_TOOL_NAME,
  description:
    "Submit a single factual correction you have found and verified. " +
    "Call this tool for each incorrect claim you discover — do not wait " +
    "until you have found all claims.",
  strict: true,
  parameters: toStrictModeParameters(submitCorrectionParametersSchema),
};

export function parseSubmitCorrectionArguments(
  argumentsJson: string,
): ClaimToolArguments<InvestigationClaimPayload> {
  return parseToolArguments(investigationClaimPayloadSchema, argumentsJson);
}

// ── retain_correction (update investigations only) ──────────────────────────

function retainCorrectionParametersSchema(retainableClaimIds: readonly [string, ...string[]]) {
  return z
    .object({
      id: z.enum(retainableClaimIds).describe("The ID of the existing claim to retain."),
    })
    .strict();
}

/**
 * Carries a previously validated claim forward unchanged. The `id` enum is
 * exactly the prior investigation's claim ids.
 */
export function buildRetainCorrectionToolDefinition(
  retainableClaimIds: readonly [string, ...string[]],
): FunctionTool {
  return {
    type: "function",
    name: RETAIN_CORRECTION_TOOL_NAME,
    description:
      "Retain an existing claim from the previous investigation that is " +
      "still correct and relevant. Use this instead of re-submitting the " +
      "same claim via submit_correction.",
    strict: true,
    parameters: toStrictModeParameters(retainCorrectionParametersSchema(retainableClaimIds)),
  };
}

/** Returns the claim id to retain. */
export function parseRetainCorrectionArguments(
  argumentsJson: string,
  retainableClaimIds: readonly [string, ...string[]],
): ClaimToolArguments<string> {
  const parsed = parseToolArguments(
    retainCorrectionParametersSchema(retainableClaimIds),
    argumentsJson,
  );
  return parsed.kind === "valid" ? { kind: "valid", value: parsed.value.id } : parsed;
}
