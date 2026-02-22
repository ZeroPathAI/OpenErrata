import { z } from "zod";
import {
  CHECK_STATUS_VALUES,
  CONTENT_PROVENANCE_VALUES,
  PLATFORM_VALUES,
} from "./enums.js";
import { MAX_BATCH_STATUS_POSTS } from "./constants.js";

// ── Shared enum schemas ───────────────────────────────────────────────────

export const platformSchema = z.enum(PLATFORM_VALUES);
export const checkStatusSchema = z.enum(CHECK_STATUS_VALUES);
export const contentProvenanceSchema = z.enum(CONTENT_PROVENANCE_VALUES);
export const sha256HashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 hex digest");
export const postMediaStateSchema = z.enum([
  "text_only",
  "has_images",
  "video_only",
]);

// ── LLM output validation ─────────────────────────────────────────────────

export const claimSourceSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1),
  snippet: z.string().min(1),
});

export const investigationClaimSchema = z.object({
  text: z.string().min(1),
  context: z.string().min(1),
  summary: z.string().min(1),
  reasoning: z.string().min(1),
  sources: z.array(claimSourceSchema).min(1),
});

export const investigationResultSchema = z.object({
  claims: z.array(investigationClaimSchema),
});

// ── Platform metadata schemas ─────────────────────────────────────────────

export const lesswrongMetadataSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1).optional(),
  htmlContent: z.string().min(1),
  authorName: z.string().min(1).optional(),
  authorSlug: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1)),
  publishedAt: z.string().datetime().optional(),
});

export const xMetadataSchema = z.object({
  authorHandle: z.string().min(1),
  authorDisplayName: z.string().min(1).nullable().optional(),
  text: z.string().min(1),
  mediaUrls: z.array(z.string().url()),
  likeCount: z.number().int().nonnegative().optional(),
  retweetCount: z.number().int().nonnegative().optional(),
  postedAt: z.string().datetime().optional(),
});

export const substackMetadataSchema = z.object({
  substackPostId: z.string().regex(/^\d+$/),
  publicationSubdomain: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().min(1).optional(),
  authorName: z.string().min(1),
  authorSubstackHandle: z.string().min(1).optional(),
  publishedAt: z.string().datetime().optional(),
  likeCount: z.number().int().nonnegative().optional(),
  commentCount: z.number().int().nonnegative().optional(),
});

// ── Core request/response schemas ─────────────────────────────────────────

const viewPostInputBaseSchema = z.object({
  externalId: z.string().min(1),
  url: z.string().url(),
  observedContentText: z.string().min(1),
  observedImageUrls: z.array(z.string().url()).optional(),
});

const lesswrongViewPostInputSchema = viewPostInputBaseSchema.extend({
  platform: z.literal("LESSWRONG"),
  metadata: lesswrongMetadataSchema,
});

const xViewPostInputSchema = viewPostInputBaseSchema.extend({
  platform: z.literal("X"),
  metadata: xMetadataSchema,
});

const substackViewPostInputSchema = viewPostInputBaseSchema.extend({
  platform: z.literal("SUBSTACK"),
  metadata: substackMetadataSchema,
});

export const viewPostInputSchema = z.discriminatedUnion("platform", [
  lesswrongViewPostInputSchema,
  xViewPostInputSchema,
  substackViewPostInputSchema,
]);

export const viewPostOutputSchema = z.object({
  investigated: z.boolean(),
  provenance: contentProvenanceSchema.optional(),
  claims: z.array(investigationClaimSchema).nullable(),
});

export const investigationStatusOutputSchema = viewPostOutputSchema.extend({
  status: checkStatusSchema.optional(),
});

export const getInvestigationInputSchema = z.object({
  investigationId: z.string().min(1),
});

export const getInvestigationOutputSchema = z.object({
  investigated: z.boolean(),
  status: checkStatusSchema.optional(),
  provenance: contentProvenanceSchema.optional(),
  claims: z.array(investigationClaimSchema).nullable(),
  checkedAt: z.string().datetime().optional(),
});

export const investigateNowInputSchema = z.discriminatedUnion("platform", [
  lesswrongViewPostInputSchema,
  xViewPostInputSchema,
  substackViewPostInputSchema,
]);

export const investigateNowOutputSchema = z.object({
  investigationId: z.string().min(1),
  status: checkStatusSchema,
  provenance: contentProvenanceSchema,
  claims: z.array(investigationClaimSchema).optional(),
});

export const openaiApiKeyFormatSchema = z
  .string()
  .regex(/^sk-[A-Za-z0-9_-]{20,}$/, "Expected an OpenAI API key beginning with sk-");

export const openaiApiKeyValidationStatusSchema = z.enum([
  "missing",
  "format_invalid",
  "valid",
  "authenticated_restricted",
  "invalid",
  "error",
]);

export const settingsValidationOutputSchema = z.object({
  instanceApiKeyAccepted: z.boolean(),
  openaiApiKeyStatus: openaiApiKeyValidationStatusSchema,
  openaiApiKeyMessage: z.string().optional(),
});

export const batchStatusInputSchema = z.object({
  posts: z
    .array(
      z.object({
        platform: platformSchema,
        externalId: z.string().min(1),
      }),
    )
    .min(1)
    .max(MAX_BATCH_STATUS_POSTS),
});

export const batchStatusOutputSchema = z.object({
  statuses: z.array(
    z.object({
      platform: platformSchema,
      externalId: z.string().min(1),
      investigated: z.boolean(),
      incorrectClaimCount: z.number().int().nonnegative(),
    }),
  ),
});

// ── Extension runtime protocol schemas ────────────────────────────────────

const platformContentBaseSchema = z.object({
  externalId: z.string().min(1),
  url: z.string().url(),
  // Normalized plain text as observed by the client. This may be an empty
  // string for valid image-only posts.
  contentText: z.string(),
  mediaState: postMediaStateSchema,
  imageUrls: z.array(z.string().url()),
});

const lesswrongPlatformContentSchema = platformContentBaseSchema.extend({
  platform: z.literal("LESSWRONG"),
  metadata: lesswrongMetadataSchema,
});

const xPlatformContentSchema = platformContentBaseSchema.extend({
  platform: z.literal("X"),
  metadata: xMetadataSchema,
});

const substackPlatformContentSchema = platformContentBaseSchema.extend({
  platform: z.literal("SUBSTACK"),
  metadata: substackMetadataSchema,
});

export const platformContentSchema = z.discriminatedUnion("platform", [
  lesswrongPlatformContentSchema,
  xPlatformContentSchema,
  substackPlatformContentSchema,
]);

const extensionPostStatusBaseSchema = z.object({
  kind: z.literal("POST"),
  tabSessionId: z.number().int().nonnegative(),
  platform: platformSchema,
  externalId: z.string().min(1),
  pageUrl: z.string().url(),
  investigationId: z.string().min(1).optional(),
  provenance: contentProvenanceSchema.optional(),
});

const extensionPostNotInvestigatedSchema = extensionPostStatusBaseSchema.extend({
  investigationState: z.literal("NOT_INVESTIGATED"),
  status: z.undefined().optional(),
  claims: z.null(),
});

const extensionPostInvestigatingSchema = extensionPostStatusBaseSchema.extend({
  investigationState: z.literal("INVESTIGATING"),
  status: z.union([z.literal("PENDING"), z.literal("PROCESSING")]),
  claims: z.null(),
});

const extensionPostFailedSchema = extensionPostStatusBaseSchema.extend({
  investigationState: z.literal("FAILED"),
  status: z.literal("FAILED"),
  claims: z.null(),
});

const extensionPostInvestigatedSchema = extensionPostStatusBaseSchema.extend({
  investigationState: z.literal("INVESTIGATED"),
  status: z.literal("COMPLETE").optional(),
  claims: z.array(investigationClaimSchema),
});

export const extensionPostStatusSchema = z.discriminatedUnion("investigationState", [
  extensionPostNotInvestigatedSchema,
  extensionPostInvestigatingSchema,
  extensionPostFailedSchema,
  extensionPostInvestigatedSchema,
]);

const extensionSkippedReasonSchema = z.enum([
  "video_only",
  "word_count",
  "unsupported_content",
]);

export const extensionSkippedStatusSchema = z.object({
  kind: z.literal("SKIPPED"),
  tabSessionId: z.number().int().nonnegative(),
  platform: platformSchema,
  externalId: z.string().min(1),
  pageUrl: z.string().url(),
  reason: extensionSkippedReasonSchema,
});

export const extensionPageStatusSchema = z.union([
  extensionPostStatusSchema,
  extensionSkippedStatusSchema,
]);

export const requestInvestigateResponseSchema = z.object({
  ok: z.boolean(),
});

export const annotationVisibilityResponseSchema = z.object({
  visible: z.boolean(),
});

export const extensionRuntimeErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
});

export const contentControlMessageSchema = z.union([
  z.object({ type: z.literal("REQUEST_INVESTIGATE") }),
  z.object({ type: z.literal("SHOW_ANNOTATIONS") }),
  z.object({ type: z.literal("HIDE_ANNOTATIONS") }),
  z.object({ type: z.literal("GET_ANNOTATION_VISIBILITY") }),
]);

export const extensionMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("PAGE_CONTENT"),
    payload: z.object({
      tabSessionId: z.number().int().nonnegative(),
      content: platformContentSchema,
    }),
  }),
  z.object({
    type: z.literal("PAGE_SKIPPED"),
    payload: z.object({
      tabSessionId: z.number().int().nonnegative(),
      platform: platformSchema,
      externalId: z.string().min(1),
      pageUrl: z.string().url(),
      reason: extensionSkippedReasonSchema,
    }),
  }),
  z.object({
    type: z.literal("PAGE_RESET"),
    payload: z.object({
      tabSessionId: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    type: z.literal("GET_STATUS"),
    payload: getInvestigationInputSchema.extend({
      tabSessionId: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    type: z.literal("INVESTIGATE_NOW"),
    payload: z.object({
      tabSessionId: z.number().int().nonnegative(),
      request: viewPostInputSchema,
    }),
  }),
  z.object({ type: z.literal("REQUEST_INVESTIGATE") }),
  z.object({ type: z.literal("SHOW_ANNOTATIONS") }),
  z.object({ type: z.literal("HIDE_ANNOTATIONS") }),
  z.object({ type: z.literal("GET_ANNOTATION_VISIBILITY") }),
  z.object({ type: z.literal("GET_CACHED") }),
  z.object({
    type: z.literal("STATUS_RESPONSE"),
    payload: investigationStatusOutputSchema,
  }),
  z.object({
    type: z.literal("ANNOTATIONS"),
    payload: z.object({ claims: z.array(investigationClaimSchema) }),
  }),
]);

// ── Generic transport schemas ─────────────────────────────────────────────

export const trpcErrorSchema = z
  .object({ message: z.string().optional() })
  .passthrough();

export const trpcJsonDataSchema = z
  .object({ json: z.unknown() })
  .passthrough();

export const trpcResultSchema = z
  .object({ data: z.unknown() })
  .passthrough();

export const trpcEnvelopeSchema = z
  .object({
    error: z.unknown().optional(),
    result: trpcResultSchema.optional(),
  })
  .passthrough();

// ── Public API schemas ────────────────────────────────────────────────────

export const getPublicInvestigationInputSchema = z.object({
  investigationId: z.string().min(1),
});

export const getPostInvestigationsInputSchema = z.object({
  platform: platformSchema,
  externalId: z.string().min(1),
});

export const searchInvestigationsInputSchema = z.object({
  query: z.string().optional(),
  platform: platformSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export const getMetricsInputSchema = z.object({
  platform: platformSchema.optional(),
  authorId: z.string().optional(),
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
});
