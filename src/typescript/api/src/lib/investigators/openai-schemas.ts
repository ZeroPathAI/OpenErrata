import { z } from "zod";

export const claimValidationResultSchema = z
  .object({
    approved: z.boolean(),
  })
  .strict();

// OpenAI structured outputs currently reject JSON Schema `format: "uri"`.
// Keep provider-facing schema to plain strings/patterns, then enforce the
// full shared schema (`investigationResultSchema`) before returning.
export const providerStructuredSourceUrlSchema = z
  .string()
  .min(1)
  .regex(/^https?:\/\/\S+$/i, "Source URL must be an absolute http(s) URL");

export const providerStructuredInvestigationClaimPayloadSchema = z
  .object({
    text: z.string().min(1),
    context: z.string().min(1),
    summary: z.string().min(1),
    reasoning: z.string().min(1),
    sources: z
      .array(
        z
          .object({
            url: providerStructuredSourceUrlSchema,
            title: z.string().min(1),
            snippet: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const providerStructuredInvestigationResultSchema = z
  .object({
    claims: z.array(providerStructuredInvestigationClaimPayloadSchema),
  })
  .strict();

const updateNewActionSchema = z
  .object({
    type: z.literal("new"),
    claim: providerStructuredInvestigationClaimPayloadSchema,
  })
  .strict();

/**
 * Build the update investigation result schema dynamically based on the set of
 * old claim IDs. When old claims exist, the model may emit "carry" actions
 * referencing exactly those IDs (enforced via z.enum) or "new" actions. When
 * there are no old claims, only "new" actions are permitted — carry actions are
 * structurally impossible.
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- return type is intentionally inferred; the complex union depends on the runtime oldClaimIds value
export function buildUpdateInvestigationResultSchema(oldClaimIds: [string, ...string[]] | []) {
  const actionSchema =
    oldClaimIds.length > 0
      ? z.union([
          z
            .object({
              type: z.literal("carry"),
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- guarded by oldClaimIds.length > 0 above
              id: z.enum(oldClaimIds as [string, ...string[]]),
            })
            .strict(),
          updateNewActionSchema,
        ])
      : updateNewActionSchema;

  return z.object({ actions: z.array(actionSchema) }).strict();
}
