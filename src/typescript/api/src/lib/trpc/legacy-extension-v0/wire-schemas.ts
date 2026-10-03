/**
 * The extension-facing tRPC wire schemas of the legacy v0 protocol: what the
 * API accepted and returned at commit 9ee2cae (extensions 0.2.0–0.3.3 parse
 * responses with these exact strict schemas).
 *
 * Vendored, not imported: copied from `shared/src/schemas/{common,
 * investigation,settings}.ts` and `shared/src/{constants,enums}.ts` at
 * 9ee2cae, so the current schemas can keep evolving without silently changing
 * what old clients are promised. Changes from the originals: only the wire
 * shapes the API serves are kept, and type-level `.brand()`s are dropped
 * (they never affected what parses). Do not edit these to match the current
 * protocol; delete them with the adapter.
 */

import { z } from "zod";

// ── shared/src/constants.ts, shared/src/enums.ts ──────────────────────────

const MAX_BATCH_STATUS_POSTS = 100;
const MAX_OBSERVED_IMAGE_OCCURRENCES = 256;
const MAX_OBSERVED_CONTENT_TEXT_CHARS = 500_000;
const MAX_OBSERVED_CONTENT_TEXT_UTF8_BYTES = 500_000;
const PLATFORM_VALUES = ["LESSWRONG", "X", "SUBSTACK", "WIKIPEDIA"] as const;
const CONTENT_PROVENANCE_VALUES = ["SERVER_VERIFIED", "CLIENT_FALLBACK"] as const;
const WIKIPEDIA_LANGUAGE_CODE_REGEX = /^[a-z][a-z0-9-]*$/i;

// ── shared/src/schemas/common.ts ──────────────────────────────────────────

const platformSchema = z.enum(PLATFORM_VALUES);
const contentProvenanceSchema = z.enum(CONTENT_PROVENANCE_VALUES);

const utf8Encoder = new TextEncoder();

function utf8ByteLength(input: string): number {
  return utf8Encoder.encode(input).byteLength;
}

const observedContentTextSchema = z
  .string()
  .min(1)
  .max(MAX_OBSERVED_CONTENT_TEXT_CHARS)
  .refine((value) => utf8ByteLength(value) <= MAX_OBSERVED_CONTENT_TEXT_UTF8_BYTES, {
    message: `Observed content text must be at most ${MAX_OBSERVED_CONTENT_TEXT_UTF8_BYTES.toString()} UTF-8 bytes`,
  });

const observedImageOccurrenceSchema = z
  .object({
    originalIndex: z.number().int().nonnegative(),
    normalizedTextOffset: z.number().int().nonnegative(),
    sourceUrl: z.url(),
    captionText: z.string().min(1).optional(),
  })
  .strict();

const observedImageOccurrencesSchema = z
  .array(observedImageOccurrenceSchema)
  .max(MAX_OBSERVED_IMAGE_OCCURRENCES);

const postIdSchema = z.string().min(1);
const postVersionIdSchema = z.string().min(1);
const investigationIdSchema = z.string().min(1);
const claimIdSchema = z.string().min(1);
const versionHashSchema = z.string().regex(/^[a-f0-9]{64}$/i);

const claimSourceSchema = z
  .object({
    url: z.url(),
    title: z.string().min(1),
    snippet: z.string().min(1),
  })
  .strict();

const investigationClaimPayloadSchema = z
  .object({
    text: z.string().min(1),
    context: z.string().min(1),
    summary: z.string().min(1),
    reasoning: z.string().min(1),
    sources: z.array(claimSourceSchema).min(1),
  })
  .strict();

const investigationClaimSchema = investigationClaimPayloadSchema
  .extend({
    id: claimIdSchema,
  })
  .strict();

const lesswrongMetadataSchema = z
  .object({
    slug: z.string().min(1),
    title: z.string().min(1).optional(),
    htmlContent: z.string().min(1),
    authorName: z.string().min(1).optional(),
    authorSlug: z.string().min(1).nullable().optional(),
    tags: z.array(z.string().min(1)),
    publishedAt: z.iso.datetime().optional(),
  })
  .strict();

const xMetadataSchema = z
  .object({
    authorHandle: z.string().min(1),
    authorDisplayName: z.string().min(1).nullable().optional(),
    text: observedContentTextSchema,
    mediaUrls: z.array(z.url()),
    likeCount: z.number().int().nonnegative().optional(),
    retweetCount: z.number().int().nonnegative().optional(),
    postedAt: z.iso.datetime().optional(),
  })
  .strict();

const substackMetadataSchema = z
  .object({
    substackPostId: z.string().regex(/^\d+$/),
    publicationSubdomain: z.string().min(1),
    slug: z.string().min(1),
    title: z.string().min(1),
    subtitle: z.string().min(1).optional(),
    htmlContent: z.string().min(1).optional(),
    authorName: z.string().min(1),
    authorSubstackHandle: z.string().min(1).optional(),
    publishedAt: z.iso.datetime().optional(),
    likeCount: z.number().int().nonnegative().optional(),
    commentCount: z.number().int().nonnegative().optional(),
  })
  .strict();

const wikipediaMetadataSchema = z
  .object({
    language: z.string().regex(WIKIPEDIA_LANGUAGE_CODE_REGEX),
    title: z.string().min(1),
    pageId: z.string().regex(/^\d+$/),
    revisionId: z.string().regex(/^\d+$/),
    displayTitle: z.string().min(1).optional(),
    lastModifiedAt: z.iso.datetime().optional(),
    htmlContent: z.string().min(1).optional(),
  })
  .strict();

// ── shared/src/schemas/investigation.ts ───────────────────────────────────

const versionedPostInputSharedSchema = z
  .object({
    url: z.url(),
    observedImageUrls: z.array(z.url()).optional(),
    observedImageOccurrences: observedImageOccurrencesSchema.optional(),
  })
  .strict();

const nonWikipediaViewPostInputSharedSchema = versionedPostInputSharedSchema
  .extend({
    externalId: postIdSchema,
  })
  .strict();

const lesswrongViewPostInputSchema = nonWikipediaViewPostInputSharedSchema
  .extend({
    platform: z.literal("LESSWRONG"),
    metadata: lesswrongMetadataSchema,
  })
  .strict();

const xViewPostInputSchema = nonWikipediaViewPostInputSharedSchema
  .extend({
    platform: z.literal("X"),
    observedContentText: observedContentTextSchema,
    metadata: xMetadataSchema,
  })
  .strict();

const substackViewPostInputSchema = nonWikipediaViewPostInputSharedSchema
  .extend({
    platform: z.literal("SUBSTACK"),
    observedContentText: observedContentTextSchema,
    metadata: substackMetadataSchema,
  })
  .strict();

const wikipediaViewPostInputSchema = versionedPostInputSharedSchema
  .extend({
    platform: z.literal("WIKIPEDIA"),
    observedContentText: observedContentTextSchema,
    metadata: wikipediaMetadataSchema,
  })
  .strict();

export const legacyRegisterObservedVersionInputSchema = z.discriminatedUnion("platform", [
  lesswrongViewPostInputSchema,
  xViewPostInputSchema,
  substackViewPostInputSchema,
  wikipediaViewPostInputSchema,
]);

export const legacyRegisterObservedVersionOutputSchema = z
  .object({
    platform: platformSchema,
    externalId: postIdSchema,
    versionHash: versionHashSchema,
    postVersionId: postVersionIdSchema,
    provenance: contentProvenanceSchema,
  })
  .strict();

const versionedPostInputSchema = z
  .object({
    postVersionId: postVersionIdSchema,
  })
  .strict();

const priorInvestigationResultSchema = z
  .object({
    oldClaims: z.array(investigationClaimSchema),
    sourceInvestigationId: investigationIdSchema,
  })
  .strict();

const investigationStatusNotInvestigatedSchema = z
  .object({
    investigationState: z.literal("NOT_INVESTIGATED"),
    priorInvestigationResult: priorInvestigationResultSchema.nullable(),
  })
  .strict();

const investigationStatusInvestigatingSchema = z
  .object({
    investigationState: z.literal("INVESTIGATING"),
    status: z.union([z.literal("PENDING"), z.literal("PROCESSING")]),
    provenance: contentProvenanceSchema,
    pendingClaims: z.array(investigationClaimPayloadSchema),
    confirmedClaims: z.array(investigationClaimPayloadSchema),
    priorInvestigationResult: priorInvestigationResultSchema.nullable(),
  })
  .strict();

const investigationStatusFailedSchema = z
  .object({
    investigationState: z.literal("FAILED"),
    provenance: contentProvenanceSchema,
  })
  .strict();

const investigationStatusInvestigatedSchema = z
  .object({
    investigationState: z.literal("INVESTIGATED"),
    provenance: contentProvenanceSchema,
    claims: z.array(investigationClaimSchema),
  })
  .strict();

export const legacyRecordViewAndGetStatusInputSchema = versionedPostInputSchema;

// `viewPostOutputSchema`: no FAILED variant, and no variant carries an
// investigation id.
export const legacyRecordViewAndGetStatusOutputSchema = z.discriminatedUnion("investigationState", [
  investigationStatusNotInvestigatedSchema,
  investigationStatusInvestigatingSchema,
  investigationStatusInvestigatedSchema,
]);

export const legacyGetInvestigationInputSchema = z
  .object({
    investigationId: investigationIdSchema,
  })
  .strict();

export const legacyGetInvestigationOutputSchema = z.discriminatedUnion("investigationState", [
  investigationStatusNotInvestigatedSchema
    .extend({
      checkedAt: z.iso.datetime().optional(),
    })
    .strict(),
  investigationStatusInvestigatingSchema
    .extend({
      checkedAt: z.iso.datetime().optional(),
    })
    .strict(),
  investigationStatusFailedSchema
    .extend({
      checkedAt: z.iso.datetime().optional(),
    })
    .strict(),
  investigationStatusInvestigatedSchema
    .extend({
      checkedAt: z.iso.datetime(),
    })
    .strict(),
]);

export const legacyInvestigateNowInputSchema = versionedPostInputSchema;

export const legacyInvestigateNowOutputSchema = z.discriminatedUnion("status", [
  z
    .object({
      investigationId: investigationIdSchema,
      status: z.union([z.literal("PENDING"), z.literal("PROCESSING")]),
      provenance: contentProvenanceSchema,
    })
    .strict(),
  z
    .object({
      investigationId: investigationIdSchema,
      status: z.literal("FAILED"),
      provenance: contentProvenanceSchema,
    })
    .strict(),
  z
    .object({
      investigationId: investigationIdSchema,
      status: z.literal("COMPLETE"),
      provenance: contentProvenanceSchema,
      claims: z.array(investigationClaimSchema),
    })
    .strict(),
]);

// ── shared/src/schemas/settings.ts ────────────────────────────────────────

// validateSettings had no `.input()`: clients send no input at all.
export const legacyValidateSettingsInputSchema = z.undefined();

export const legacyValidateSettingsOutputSchema = z.discriminatedUnion("openaiApiKeyStatus", [
  z
    .object({
      instanceApiKeyAccepted: z.boolean(),
      openaiApiKeyStatus: z.literal("missing"),
    })
    .strict(),
  z
    .object({
      instanceApiKeyAccepted: z.boolean(),
      openaiApiKeyStatus: z.literal("valid"),
    })
    .strict(),
  z
    .object({
      instanceApiKeyAccepted: z.boolean(),
      openaiApiKeyStatus: z.literal("format_invalid"),
      openaiApiKeyMessage: z.string().min(1),
    })
    .strict(),
  z
    .object({
      instanceApiKeyAccepted: z.boolean(),
      openaiApiKeyStatus: z.literal("authenticated_restricted"),
      openaiApiKeyMessage: z.string().min(1),
    })
    .strict(),
  z
    .object({
      instanceApiKeyAccepted: z.boolean(),
      openaiApiKeyStatus: z.literal("invalid"),
      openaiApiKeyMessage: z.string().min(1),
    })
    .strict(),
  z
    .object({
      instanceApiKeyAccepted: z.boolean(),
      openaiApiKeyStatus: z.literal("error"),
      openaiApiKeyMessage: z.string().min(1),
    })
    .strict(),
]);

export const legacyBatchStatusInputSchema = z
  .object({
    posts: z
      .array(
        z
          .object({
            platform: platformSchema,
            externalId: postIdSchema,
            versionHash: versionHashSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_BATCH_STATUS_POSTS),
  })
  .strict();

export const legacyBatchStatusOutputSchema = z
  .object({
    statuses: z.array(
      z.discriminatedUnion("investigationState", [
        z
          .object({
            platform: platformSchema,
            externalId: postIdSchema,
            investigationState: z.literal("NOT_INVESTIGATED"),
            incorrectClaimCount: z.literal(0),
          })
          .strict(),
        z
          .object({
            platform: platformSchema,
            externalId: postIdSchema,
            investigationState: z.literal("INVESTIGATED"),
            incorrectClaimCount: z.number().int().nonnegative(),
          })
          .strict(),
      ]),
    ),
  })
  .strict();
