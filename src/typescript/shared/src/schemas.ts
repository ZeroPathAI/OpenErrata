import { z } from "zod";
import {
  CONTENT_PROVENANCE_VALUES,
  PLATFORM_VALUES,
} from "./enums.js";
import {
  MAX_BATCH_STATUS_POSTS,
  MAX_OBSERVED_CONTENT_TEXT_CHARS,
} from "./constants.js";

// ── Shared enum schemas ───────────────────────────────────────────────────

export const platformSchema = z.enum(PLATFORM_VALUES);
export const contentProvenanceSchema = z.enum(CONTENT_PROVENANCE_VALUES);
const postMediaStateSchema = z.enum([
  "text_only",
  "has_images",
  "video_only",
]);

const observedContentTextSchema = z
  .string()
  .min(1)
  .max(MAX_OBSERVED_CONTENT_TEXT_CHARS);

// ── LLM output validation ─────────────────────────────────────────────────

const claimSourceSchema = z.object({
  url: z.url(),
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

const lesswrongMetadataSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1).optional(),
  htmlContent: z.string().min(1),
  authorName: z.string().min(1).optional(),
  authorSlug: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1)),
  publishedAt: z.iso.datetime().optional(),
});

const xMetadataSchema = z.object({
  authorHandle: z.string().min(1),
  authorDisplayName: z.string().min(1).nullable().optional(),
  text: observedContentTextSchema,
  mediaUrls: z.array(z.url()),
  likeCount: z.number().int().nonnegative().optional(),
  retweetCount: z.number().int().nonnegative().optional(),
  postedAt: z.iso.datetime().optional(),
});

const substackMetadataSchema = z.object({
  substackPostId: z.string().regex(/^\d+$/),
  publicationSubdomain: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().min(1).optional(),
  authorName: z.string().min(1),
  authorSubstackHandle: z.string().min(1).optional(),
  publishedAt: z.iso.datetime().optional(),
  likeCount: z.number().int().nonnegative().optional(),
  commentCount: z.number().int().nonnegative().optional(),
});

// ── Core request/response schemas ─────────────────────────────────────────

const viewPostInputSharedSchema = z.object({
  externalId: z.string().min(1),
  url: z.url(),
  observedImageUrls: z.array(z.url()).optional(),
});

const lesswrongViewPostInputSchema = viewPostInputSharedSchema.extend({
  platform: z.literal("LESSWRONG"),
  // LessWrong versioning derives canonical text from metadata.htmlContent.
  metadata: lesswrongMetadataSchema,
}).strict();

const xViewPostInputSchema = viewPostInputSharedSchema.extend({
  platform: z.literal("X"),
  observedContentText: observedContentTextSchema,
  metadata: xMetadataSchema,
}).strict();

const substackViewPostInputSchema = viewPostInputSharedSchema.extend({
  platform: z.literal("SUBSTACK"),
  observedContentText: observedContentTextSchema,
  metadata: substackMetadataSchema,
}).strict();

export const viewPostInputSchema = z.discriminatedUnion("platform", [
  lesswrongViewPostInputSchema,
  xViewPostInputSchema,
  substackViewPostInputSchema,
]);

const investigationStatusNotInvestigatedSchema = z.object({
  investigationState: z.literal("NOT_INVESTIGATED"),
  claims: z.null(),
});

const investigationStatusInvestigatingSchema = z.object({
  investigationState: z.literal("INVESTIGATING"),
  status: z.union([z.literal("PENDING"), z.literal("PROCESSING")]),
  provenance: contentProvenanceSchema,
  claims: z.null(),
});

const investigationStatusFailedSchema = z.object({
  investigationState: z.literal("FAILED"),
  provenance: contentProvenanceSchema,
  claims: z.null(),
});

const investigationStatusInvestigatedSchema = z.object({
  investigationState: z.literal("INVESTIGATED"),
  provenance: contentProvenanceSchema,
  claims: z.array(investigationClaimSchema),
});

export const viewPostOutputSchema = z.discriminatedUnion("investigationState", [
  investigationStatusNotInvestigatedSchema,
  investigationStatusInvestigatedSchema,
]);

export const investigationStatusOutputSchema = z.discriminatedUnion(
  "investigationState",
  [
    investigationStatusNotInvestigatedSchema,
    investigationStatusInvestigatingSchema,
    investigationStatusFailedSchema,
    investigationStatusInvestigatedSchema,
  ],
);

export const getInvestigationInputSchema = z.object({
  investigationId: z.string().min(1),
});

export const getInvestigationOutputSchema = z.discriminatedUnion(
  "investigationState",
  [
    investigationStatusNotInvestigatedSchema.extend({
      checkedAt: z.iso.datetime().optional(),
    }),
    investigationStatusInvestigatingSchema.extend({
      checkedAt: z.iso.datetime().optional(),
    }),
    investigationStatusFailedSchema.extend({
      checkedAt: z.iso.datetime().optional(),
    }),
    investigationStatusInvestigatedSchema.extend({
      checkedAt: z.iso.datetime(),
    }),
  ],
);

const investigateNowOutputPendingSchema = z.object({
  investigationId: z.string().min(1),
  status: z.union([z.literal("PENDING"), z.literal("PROCESSING")]),
  provenance: contentProvenanceSchema,
});

const investigateNowOutputFailedSchema = z.object({
  investigationId: z.string().min(1),
  status: z.literal("FAILED"),
  provenance: contentProvenanceSchema,
});

const investigateNowOutputCompleteSchema = z.object({
  investigationId: z.string().min(1),
  status: z.literal("COMPLETE"),
  provenance: contentProvenanceSchema,
  claims: z.array(investigationClaimSchema),
});

export const investigateNowOutputSchema = z.discriminatedUnion("status", [
  investigateNowOutputPendingSchema,
  investigateNowOutputFailedSchema,
  investigateNowOutputCompleteSchema,
]);

export const openaiApiKeyFormatSchema = z
  .string()
  .regex(/^sk-[A-Za-z0-9_-]{20,}$/, "Expected an OpenAI API key beginning with sk-");

const settingsValidationMissingSchema = z.object({
  instanceApiKeyAccepted: z.boolean(),
  openaiApiKeyStatus: z.literal("missing"),
});

const settingsValidationValidSchema = z.object({
  instanceApiKeyAccepted: z.boolean(),
  openaiApiKeyStatus: z.literal("valid"),
});

const settingsValidationFormatInvalidSchema = z.object({
  instanceApiKeyAccepted: z.boolean(),
  openaiApiKeyStatus: z.literal("format_invalid"),
  openaiApiKeyMessage: z.string().min(1),
});

const settingsValidationAuthenticatedRestrictedSchema = z.object({
  instanceApiKeyAccepted: z.boolean(),
  openaiApiKeyStatus: z.literal("authenticated_restricted"),
  openaiApiKeyMessage: z.string().min(1),
});

const settingsValidationInvalidSchema = z.object({
  instanceApiKeyAccepted: z.boolean(),
  openaiApiKeyStatus: z.literal("invalid"),
  openaiApiKeyMessage: z.string().min(1),
});

const settingsValidationErrorSchema = z.object({
  instanceApiKeyAccepted: z.boolean(),
  openaiApiKeyStatus: z.literal("error"),
  openaiApiKeyMessage: z.string().min(1),
});

export const settingsValidationOutputSchema = z.discriminatedUnion(
  "openaiApiKeyStatus",
  [
    settingsValidationMissingSchema,
    settingsValidationValidSchema,
    settingsValidationFormatInvalidSchema,
    settingsValidationAuthenticatedRestrictedSchema,
    settingsValidationInvalidSchema,
    settingsValidationErrorSchema,
  ],
);

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
    z.discriminatedUnion("investigationState", [
      z.object({
        platform: platformSchema,
        externalId: z.string().min(1),
        investigationState: z.literal("NOT_INVESTIGATED"),
        incorrectClaimCount: z.literal(0),
      }),
      z.object({
        platform: platformSchema,
        externalId: z.string().min(1),
        investigationState: z.literal("INVESTIGATED"),
        incorrectClaimCount: z.number().int().nonnegative(),
      }),
    ]),
  ),
});

// ── Extension runtime protocol schemas ────────────────────────────────────

const platformContentBaseSchema = z.object({
  externalId: z.string().min(1),
  url: z.url(),
  // Normalized plain text as observed by the client.
  // Textless content is currently treated as unsupported.
  contentText: observedContentTextSchema,
  mediaState: postMediaStateSchema,
  imageUrls: z.array(z.url()),
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
  pageUrl: z.url(),
  investigationId: z.string().min(1).optional(),
});

const extensionPostNotInvestigatedSchema = extensionPostStatusBaseSchema.extend({
  investigationState: z.literal("NOT_INVESTIGATED"),
  status: z.undefined().optional(),
  claims: z.null(),
});

const extensionPostInvestigatingSchema = extensionPostStatusBaseSchema.extend({
  investigationState: z.literal("INVESTIGATING"),
  status: z.union([z.literal("PENDING"), z.literal("PROCESSING")]),
  provenance: contentProvenanceSchema,
  claims: z.null(),
});

const extensionPostFailedSchema = extensionPostStatusBaseSchema.extend({
  investigationState: z.literal("FAILED"),
  provenance: contentProvenanceSchema.optional(),
  claims: z.null(),
});

const extensionPostContentMismatchSchema = extensionPostStatusBaseSchema.extend({
  investigationState: z.literal("CONTENT_MISMATCH"),
  status: z.undefined().optional(),
  claims: z.null(),
});

const extensionPostInvestigatedSchema = extensionPostStatusBaseSchema.extend({
  investigationState: z.literal("INVESTIGATED"),
  provenance: contentProvenanceSchema,
  claims: z.array(investigationClaimSchema),
});

export const extensionPostStatusSchema = z.discriminatedUnion("investigationState", [
  extensionPostNotInvestigatedSchema,
  extensionPostInvestigatingSchema,
  extensionPostFailedSchema,
  extensionPostContentMismatchSchema,
  extensionPostInvestigatedSchema,
]);

const extensionSkippedReasonSchema = z.enum([
  "video_only",
  "word_count",
  "no_text",
  "private_or_gated",
  "unsupported_content",
]);

export const extensionSkippedStatusSchema = z.object({
  kind: z.literal("SKIPPED"),
  tabSessionId: z.number().int().nonnegative(),
  platform: platformSchema,
  externalId: z.string().min(1),
  pageUrl: z.url(),
  reason: extensionSkippedReasonSchema,
});

export const extensionPageStatusSchema = z.union([
  extensionPostStatusSchema,
  extensionSkippedStatusSchema,
]);

export const requestInvestigateResponseSchema = z.object({
  ok: z.boolean(),
});

export const focusClaimResponseSchema = z.object({
  ok: z.boolean(),
});

export const annotationVisibilityResponseSchema = z.object({
  visible: z.boolean(),
});

export const extensionRuntimeErrorCodeSchema = z.enum([
  "CONTENT_MISMATCH",
]);

export const extensionRuntimeErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
  errorCode: extensionRuntimeErrorCodeSchema.optional(),
});

const requestInvestigateMessageSchema = z.object({
  type: z.literal("REQUEST_INVESTIGATE"),
});

const showAnnotationsMessageSchema = z.object({
  type: z.literal("SHOW_ANNOTATIONS"),
});

const hideAnnotationsMessageSchema = z.object({
  type: z.literal("HIDE_ANNOTATIONS"),
});

const getAnnotationVisibilityMessageSchema = z.object({
  type: z.literal("GET_ANNOTATION_VISIBILITY"),
});

const focusClaimMessageSchema = z.object({
  type: z.literal("FOCUS_CLAIM"),
  payload: z.object({
    claimIndex: z.number().int().nonnegative(),
  }),
});

const contentControlMessageSchemas = [
  requestInvestigateMessageSchema,
  showAnnotationsMessageSchema,
  hideAnnotationsMessageSchema,
  getAnnotationVisibilityMessageSchema,
  focusClaimMessageSchema,
] as const;

export const contentControlMessageSchema = z.union(contentControlMessageSchemas);

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
      pageUrl: z.url(),
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
  ...contentControlMessageSchemas,
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
  windowStart: z.iso.datetime().optional(),
  windowEnd: z.iso.datetime().optional(),
});

const publicInvestigationOriginServerVerifiedSchema = z.object({
  provenance: z.literal("SERVER_VERIFIED"),
  serverVerifiedAt: z.iso.datetime(),
});

const publicInvestigationOriginClientFallbackSchema = z.object({
  provenance: z.literal("CLIENT_FALLBACK"),
  fetchFailureReason: z.string().min(1),
});

export const publicInvestigationOriginSchema = z.discriminatedUnion("provenance", [
  publicInvestigationOriginServerVerifiedSchema,
  publicInvestigationOriginClientFallbackSchema,
]);

const publicPostSchema = z.object({
  platform: platformSchema,
  externalId: z.string().min(1),
  url: z.url(),
});

const publicInvestigationMetadataSchema = z.object({
  id: z.string().min(1),
  corroborationCount: z.number().int().nonnegative(),
  checkedAt: z.iso.datetime(),
  promptVersion: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  origin: publicInvestigationOriginSchema,
});

export const publicGetInvestigationOutputSchema = z
  .object({
    investigation: publicInvestigationMetadataSchema,
    post: publicPostSchema,
    claims: z.array(investigationClaimSchema),
  })
  .nullable();

export const publicGetPostInvestigationsOutputSchema = z.object({
  post: publicPostSchema.nullable(),
  investigations: z.array(
    z.object({
      id: z.string().min(1),
      contentHash: z.string().min(1),
      corroborationCount: z.number().int().nonnegative(),
      checkedAt: z.iso.datetime(),
      claimCount: z.number().int().nonnegative(),
      origin: publicInvestigationOriginSchema,
    }),
  ),
});

export const publicSearchInvestigationsOutputSchema = z.object({
  investigations: z.array(
    z.object({
      id: z.string().min(1),
      contentHash: z.string().min(1),
      checkedAt: z.iso.datetime(),
      platform: platformSchema,
      externalId: z.string().min(1),
      url: z.url(),
      corroborationCount: z.number().int().nonnegative(),
      claimCount: z.number().int().nonnegative(),
      origin: publicInvestigationOriginSchema,
    }),
  ),
});

export const publicGetMetricsOutputSchema = z.object({
  totalInvestigatedPosts: z.number().int().nonnegative(),
  investigatedPostsWithFlags: z.number().int().nonnegative(),
  factCheckIncidence: z.number().nonnegative(),
});
