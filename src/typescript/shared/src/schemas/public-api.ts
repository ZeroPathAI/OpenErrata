import { z } from "zod";
import {
  investigationIdSchema,
  platformSchema,
  postIdSchema,
  versionHashSchema,
  contentProvenanceSchema,
  investigationClaimSchema,
} from "./common.js";

export const getPublicInvestigationInputSchema = z
  .object({
    investigationId: investigationIdSchema,
  })
  .strict();

export const getPostInvestigationsInputSchema = z
  .object({
    platform: platformSchema,
    externalId: postIdSchema,
  })
  .strict();

export const searchInvestigationsInputSchema = z
  .object({
    query: z.string().trim().min(1).optional(),
    platform: platformSchema.optional(),
    /** Only return investigations with at least this many claims. */
    minClaimCount: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export const getMetricsInputSchema = z
  .object({
    platform: platformSchema.optional(),
    authorId: z.string().min(1).optional(),
    windowStart: z.iso.datetime().optional(),
    windowEnd: z.iso.datetime().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.windowStart === undefined || value.windowEnd === undefined) {
      return;
    }

    const startTime = new Date(value.windowStart).getTime();
    const endTime = new Date(value.windowEnd).getTime();

    if (Number.isNaN(startTime) || Number.isNaN(endTime)) {
      return;
    }

    if (startTime > endTime) {
      ctx.addIssue({
        code: "custom",
        path: ["windowEnd"],
        message: "`windowEnd` must be greater than or equal to `windowStart`",
      });
    }
  })
  .strict();

const publicInvestigationOriginSchema = z
  .object({
    provenance: contentProvenanceSchema,
    serverVerifiedAt: z.iso.datetime().optional(),
  })
  .strict();

const publicPostSchema = z
  .object({
    platform: platformSchema,
    externalId: postIdSchema,
    url: z.url(),
  })
  .strict();

const publicInvestigationMetadataSchema = z
  .object({
    id: investigationIdSchema,
    corroborationCount: z.number().int().nonnegative(),
    checkedAt: z.iso.datetime(),
    promptVersion: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    origin: publicInvestigationOriginSchema,
  })
  .strict();

export const publicGetInvestigationOutputSchema = z
  .object({
    investigation: publicInvestigationMetadataSchema,
    post: publicPostSchema,
    claims: z.array(investigationClaimSchema),
  })
  .strict()
  .nullable();

export const publicGetPostInvestigationsOutputSchema = z
  .object({
    post: publicPostSchema.nullable(),
    investigations: z.array(
      z
        .object({
          id: investigationIdSchema,
          contentHash: versionHashSchema,
          corroborationCount: z.number().int().nonnegative(),
          checkedAt: z.iso.datetime(),
          claimCount: z.number().int().nonnegative(),
          origin: publicInvestigationOriginSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const publicSearchInvestigationsOutputSchema = z
  .object({
    investigations: z.array(
      z
        .object({
          id: investigationIdSchema,
          contentHash: versionHashSchema,
          checkedAt: z.iso.datetime(),
          platform: platformSchema,
          externalId: postIdSchema,
          url: z.url(),
          corroborationCount: z.number().int().nonnegative(),
          claimCount: z.number().int().nonnegative(),
          origin: publicInvestigationOriginSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const publicGetMetricsOutputSchema = z
  .object({
    totalInvestigatedPosts: z.number().int().nonnegative(),
    investigatedPostsWithFlags: z.number().int().nonnegative(),
    factCheckIncidence: z.number().nonnegative(),
  })
  .strict();
