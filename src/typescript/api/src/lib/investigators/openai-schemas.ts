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
