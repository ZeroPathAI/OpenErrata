import { z } from "zod";
import { INVESTIGATION_PROVIDER_VALUES } from "../enums.js";
import {
  claimIdSchema,
  contentProvenanceSchema,
  httpUrlSchema,
  investigationIdSchema,
  platformSchema,
  postIdSchema,
  versionHashSchema,
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

/*
 * Output schemas below describe the public GraphQL wire format: nullable
 * fields are present with `null`, never omitted.
 */

/**
 * `provenance` is the immutable snapshot of how the investigated content was
 * obtained; `serverVerifiedAt` is the post version's verification latch. A
 * SERVER_VERIFIED investigation ran on verified content, so its latch is
 * always set. A CLIENT_FALLBACK investigation's latch may be set later, when a
 * subsequent server fetch verifies the same content.
 */
const publicInvestigationOriginSchema = z.discriminatedUnion("provenance", [
  z
    .object({
      provenance: contentProvenanceSchema.extract(["SERVER_VERIFIED"]),
      serverVerifiedAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      provenance: contentProvenanceSchema.extract(["CLIENT_FALLBACK"]),
      serverVerifiedAt: z.iso.datetime().nullable(),
    })
    .strict(),
]);

const publicPostSchema = z
  .object({
    platform: platformSchema,
    externalId: postIdSchema,
    url: httpUrlSchema,
  })
  .strict();

const publicInvestigationMetadataSchema = z
  .object({
    id: investigationIdSchema,
    corroborationCount: z.number().int().nonnegative(),
    checkedAt: z.iso.datetime(),
    promptVersion: z.string().min(1),
    provider: z.enum(INVESTIGATION_PROVIDER_VALUES),
    /** The provider's model id that produced the result, e.g. "gpt-6.1-sol". */
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

const claimSummarySchema = z
  .object({
    id: claimIdSchema,
    summary: z.string().min(1),
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
          url: httpUrlSchema,
          corroborationCount: z.number().int().nonnegative(),
          claimCount: z.number().int().nonnegative(),
          claimSummaries: z.array(claimSummarySchema),
          origin: publicInvestigationOriginSchema,
        })
        .strict(),
    ),
    hasMore: z.boolean(),
  })
  .strict();
