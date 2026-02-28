import { z } from "zod";
import { CONTENT_PROVENANCE_VALUES, PLATFORM_VALUES } from "./enums.js";
import {
  EXTENSION_MESSAGE_PROTOCOL_VERSION,
  MAX_BATCH_STATUS_POSTS,
  MAX_OBSERVED_CONTENT_TEXT_CHARS,
  MAX_OBSERVED_CONTENT_TEXT_UTF8_BYTES,
  MAX_OBSERVED_IMAGE_OCCURRENCES,
} from "./constants.js";

// ── Shared enum schemas ───────────────────────────────────────────────────

export const platformSchema = z.enum(PLATFORM_VALUES);
export const contentProvenanceSchema = z.enum(CONTENT_PROVENANCE_VALUES);
const postMediaStateSchema = z.enum(["text_only", "has_images", "has_video"]);

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

// ── Branded identifier schemas ────────────────────────────────────────────

const postIdSchema = z.string().min(1).brand<"PostId">();
const postVersionIdSchema = z.string().min(1).brand<"PostVersionId">();
const sessionIdSchema = z.number().int().nonnegative().brand<"SessionId">();
export const investigationIdSchema = z.string().min(1).brand<"InvestigationId">();
export const claimIdSchema = z.string().min(1).brand<"ClaimId">();
const versionHashSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const extensionMessageProtocolVersionSchema = z.literal(EXTENSION_MESSAGE_PROTOCOL_VERSION);

// ── Claim validation ──────────────────────────────────────────────────────

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

export const investigationResultSchema = z
  .object({
    claims: z.array(investigationClaimPayloadSchema),
  })
  .strict();

// ── Platform metadata schemas ─────────────────────────────────────────────

export const WIKIPEDIA_LANGUAGE_CODE_REGEX = /^[a-z][a-z0-9-]*$/i;

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
  })
  .strict();

// ── Core request/response schemas ─────────────────────────────────────────

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
    // LessWrong versioning derives canonical text from metadata.htmlContent.
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

const viewPostInputSchemas = [
  lesswrongViewPostInputSchema,
  xViewPostInputSchema,
  substackViewPostInputSchema,
  wikipediaViewPostInputSchema,
] as const;

export const viewPostInputSchema = z.discriminatedUnion("platform", viewPostInputSchemas);

export const registerObservedVersionInputSchema = z.discriminatedUnion(
  "platform",
  viewPostInputSchemas,
);

export const registerObservedVersionOutputSchema = z
  .object({
    platform: platformSchema,
    externalId: postIdSchema,
    versionHash: versionHashSchema,
    postVersionId: postVersionIdSchema,
    provenance: contentProvenanceSchema,
  })
  .strict();

function createVersionedPostInputSchema() {
  return z
    .object({
      postVersionId: postVersionIdSchema,
    })
    .strict();
}

export const priorInvestigationResultSchema = z
  .object({
    oldClaims: z.array(investigationClaimSchema),
    sourceInvestigationId: investigationIdSchema,
  })
  .strict();

const investigationStatusNotInvestigatedSchema = z
  .object({
    investigationState: z.literal("NOT_INVESTIGATED"),
    claims: z.null(),
    priorInvestigationResult: priorInvestigationResultSchema.nullable(),
  })
  .strict();

const investigationStatusInvestigatingSchema = z
  .object({
    investigationState: z.literal("INVESTIGATING"),
    status: z.union([z.literal("PENDING"), z.literal("PROCESSING")]),
    provenance: contentProvenanceSchema,
    claims: z.null(),
    priorInvestigationResult: priorInvestigationResultSchema.nullable(),
  })
  .strict();

const investigationStatusFailedSchema = z
  .object({
    investigationState: z.literal("FAILED"),
    provenance: contentProvenanceSchema,
    claims: z.null(),
  })
  .strict();

const investigationStatusInvestigatedSchema = z
  .object({
    investigationState: z.literal("INVESTIGATED"),
    provenance: contentProvenanceSchema,
    claims: z.array(investigationClaimSchema),
  })
  .strict();

export const viewPostOutputSchema = z.discriminatedUnion("investigationState", [
  investigationStatusNotInvestigatedSchema,
  investigationStatusInvestigatingSchema,
  investigationStatusInvestigatedSchema,
]);

export const investigationStatusOutputSchema = z.discriminatedUnion("investigationState", [
  investigationStatusNotInvestigatedSchema,
  investigationStatusInvestigatingSchema,
  investigationStatusFailedSchema,
  investigationStatusInvestigatedSchema,
]);

export const getInvestigationInputSchema = z
  .object({
    investigationId: investigationIdSchema,
  })
  .strict();

export const getInvestigationOutputSchema = z.discriminatedUnion("investigationState", [
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

export const recordViewAndGetStatusInputSchema = createVersionedPostInputSchema();

export const investigateNowInputSchema = createVersionedPostInputSchema();

const investigateNowOutputPendingSchema = z
  .object({
    investigationId: investigationIdSchema,
    status: z.union([z.literal("PENDING"), z.literal("PROCESSING")]),
    provenance: contentProvenanceSchema,
  })
  .strict();

const investigateNowOutputFailedSchema = z
  .object({
    investigationId: investigationIdSchema,
    status: z.literal("FAILED"),
    provenance: contentProvenanceSchema,
  })
  .strict();

const investigateNowOutputCompleteSchema = z
  .object({
    investigationId: investigationIdSchema,
    status: z.literal("COMPLETE"),
    provenance: contentProvenanceSchema,
    claims: z.array(investigationClaimSchema),
  })
  .strict();

export const investigateNowOutputSchema = z.discriminatedUnion("status", [
  investigateNowOutputPendingSchema,
  investigateNowOutputFailedSchema,
  investigateNowOutputCompleteSchema,
]);

export const openaiApiKeyFormatSchema = z
  .string()
  .regex(/^sk-[A-Za-z0-9_-]{20,}$/, "Expected an OpenAI API key beginning with sk-");

const settingsValidationMissingSchema = z
  .object({
    instanceApiKeyAccepted: z.boolean(),
    openaiApiKeyStatus: z.literal("missing"),
  })
  .strict();

const settingsValidationValidSchema = z
  .object({
    instanceApiKeyAccepted: z.boolean(),
    openaiApiKeyStatus: z.literal("valid"),
  })
  .strict();

const settingsValidationFormatInvalidSchema = z
  .object({
    instanceApiKeyAccepted: z.boolean(),
    openaiApiKeyStatus: z.literal("format_invalid"),
    openaiApiKeyMessage: z.string().min(1),
  })
  .strict();

const settingsValidationAuthenticatedRestrictedSchema = z
  .object({
    instanceApiKeyAccepted: z.boolean(),
    openaiApiKeyStatus: z.literal("authenticated_restricted"),
    openaiApiKeyMessage: z.string().min(1),
  })
  .strict();

const settingsValidationInvalidSchema = z
  .object({
    instanceApiKeyAccepted: z.boolean(),
    openaiApiKeyStatus: z.literal("invalid"),
    openaiApiKeyMessage: z.string().min(1),
  })
  .strict();

const settingsValidationErrorSchema = z
  .object({
    instanceApiKeyAccepted: z.boolean(),
    openaiApiKeyStatus: z.literal("error"),
    openaiApiKeyMessage: z.string().min(1),
  })
  .strict();

export const settingsValidationOutputSchema = z.discriminatedUnion("openaiApiKeyStatus", [
  settingsValidationMissingSchema,
  settingsValidationValidSchema,
  settingsValidationFormatInvalidSchema,
  settingsValidationAuthenticatedRestrictedSchema,
  settingsValidationInvalidSchema,
  settingsValidationErrorSchema,
]);

export const batchStatusInputSchema = z
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

export const batchStatusOutputSchema = z
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

// ── Extension runtime protocol schemas ────────────────────────────────────

const platformContentBaseSchema = z
  .object({
    externalId: z.string().min(1),
    url: z.url(),
    // Normalized plain text as observed by the client.
    // Textless content is currently treated as unsupported.
    contentText: observedContentTextSchema,
    mediaState: postMediaStateSchema,
    imageUrls: z.array(z.url()),
    imageOccurrences: observedImageOccurrencesSchema.optional(),
  })
  .strict();

const lesswrongPlatformContentSchema = platformContentBaseSchema
  .extend({
    platform: z.literal("LESSWRONG"),
    metadata: lesswrongMetadataSchema,
  })
  .strict();

const xPlatformContentSchema = platformContentBaseSchema
  .extend({
    platform: z.literal("X"),
    metadata: xMetadataSchema,
  })
  .strict();

const substackPlatformContentSchema = platformContentBaseSchema
  .extend({
    platform: z.literal("SUBSTACK"),
    metadata: substackMetadataSchema,
  })
  .strict();

const wikipediaPlatformContentSchema = platformContentBaseSchema
  .extend({
    platform: z.literal("WIKIPEDIA"),
    metadata: wikipediaMetadataSchema,
  })
  .strict();

const platformContentSchema = z.discriminatedUnion("platform", [
  lesswrongPlatformContentSchema,
  xPlatformContentSchema,
  substackPlatformContentSchema,
  wikipediaPlatformContentSchema,
]);

const extensionPostStatusBaseSchema = z
  .object({
    kind: z.literal("POST"),
    tabSessionId: sessionIdSchema,
    platform: platformSchema,
    externalId: postIdSchema,
    pageUrl: z.url(),
    investigationId: investigationIdSchema.optional(),
  })
  .strict();

const extensionPostNotInvestigatedSchema = extensionPostStatusBaseSchema
  .extend({
    investigationState: z.literal("NOT_INVESTIGATED"),
    status: z.undefined().optional(),
    claims: z.null(),
    priorInvestigationResult: priorInvestigationResultSchema.nullable(),
  })
  .strict();

const extensionPostInvestigatingSchema = extensionPostStatusBaseSchema
  .extend({
    investigationState: z.literal("INVESTIGATING"),
    status: z.union([z.literal("PENDING"), z.literal("PROCESSING")]),
    provenance: contentProvenanceSchema,
    claims: z.null(),
    priorInvestigationResult: priorInvestigationResultSchema.nullable(),
  })
  .strict();

const extensionPostFailedSchema = extensionPostStatusBaseSchema
  .extend({
    investigationState: z.literal("FAILED"),
    provenance: contentProvenanceSchema.optional(),
    claims: z.null(),
  })
  .strict();

const extensionPostContentMismatchSchema = extensionPostStatusBaseSchema
  .extend({
    investigationState: z.literal("CONTENT_MISMATCH"),
    status: z.undefined().optional(),
    claims: z.null(),
  })
  .strict();

const extensionPostInvestigatedSchema = extensionPostStatusBaseSchema
  .extend({
    investigationState: z.literal("INVESTIGATED"),
    provenance: contentProvenanceSchema,
    claims: z.array(investigationClaimSchema),
  })
  .strict();

export const extensionPostStatusSchema = z.discriminatedUnion("investigationState", [
  extensionPostNotInvestigatedSchema,
  extensionPostInvestigatingSchema,
  extensionPostFailedSchema,
  extensionPostContentMismatchSchema,
  extensionPostInvestigatedSchema,
]);

const extensionSkippedReasonSchema = z.enum([
  "has_video",
  "word_count",
  "no_text",
  "private_or_gated",
  "unsupported_content",
]);

export const extensionSkippedStatusSchema = z
  .object({
    kind: z.literal("SKIPPED"),
    tabSessionId: sessionIdSchema,
    platform: platformSchema,
    externalId: postIdSchema,
    pageUrl: z.url(),
    reason: extensionSkippedReasonSchema,
  })
  .strict();

export const extensionPageStatusSchema = z.union([
  extensionPostStatusSchema,
  extensionSkippedStatusSchema,
]);

export const requestInvestigateResponseSchema = z
  .object({
    ok: z.boolean(),
  })
  .strict();

export const focusClaimResponseSchema = z
  .object({
    ok: z.boolean(),
  })
  .strict();

export const annotationVisibilityResponseSchema = z
  .object({
    visible: z.boolean(),
  })
  .strict();

export const extensionRuntimeErrorCodeSchema = z.enum([
  "CONTENT_MISMATCH",
  "PAYLOAD_TOO_LARGE",
  "UPGRADE_REQUIRED",
  "MALFORMED_EXTENSION_VERSION",
  "INVALID_EXTENSION_MESSAGE",
  "UNSUPPORTED_PROTOCOL_VERSION",
]);

export const extensionRuntimeErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    error: z.string().min(1),
    errorCode: extensionRuntimeErrorCodeSchema.optional(),
  })
  .strict();

function extensionMessageWithPayload<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return z
    .object({
      v: extensionMessageProtocolVersionSchema,
      type: z.literal(type),
      payload,
    })
    .strict();
}

function extensionMessageWithoutPayload<TType extends string>(type: TType) {
  return z
    .object({
      v: extensionMessageProtocolVersionSchema,
      type: z.literal(type),
    })
    .strict();
}

const requestInvestigateMessageSchema = extensionMessageWithoutPayload("REQUEST_INVESTIGATE");

const showAnnotationsMessageSchema = extensionMessageWithoutPayload("SHOW_ANNOTATIONS");

const hideAnnotationsMessageSchema = extensionMessageWithoutPayload("HIDE_ANNOTATIONS");

const getAnnotationVisibilityMessageSchema = extensionMessageWithoutPayload(
  "GET_ANNOTATION_VISIBILITY",
);

const focusClaimPayloadSchema = z
  .object({
    claimId: claimIdSchema,
  })
  .strict();

const focusClaimMessageSchema = extensionMessageWithPayload("FOCUS_CLAIM", focusClaimPayloadSchema);

const contentControlMessageSchemas = [
  requestInvestigateMessageSchema,
  showAnnotationsMessageSchema,
  hideAnnotationsMessageSchema,
  getAnnotationVisibilityMessageSchema,
  focusClaimMessageSchema,
] as const;

export const contentControlMessageSchema = z.union(contentControlMessageSchemas);

export const extensionMessageSchema = z.discriminatedUnion("type", [
  extensionMessageWithPayload(
    "PAGE_CONTENT",
    z
      .object({
        tabSessionId: sessionIdSchema,
        content: platformContentSchema,
      })
      .strict(),
  ),
  extensionMessageWithPayload(
    "PAGE_SKIPPED",
    z
      .object({
        tabSessionId: sessionIdSchema,
        platform: platformSchema,
        externalId: postIdSchema,
        pageUrl: z.url(),
        reason: extensionSkippedReasonSchema,
      })
      .strict(),
  ),
  extensionMessageWithPayload(
    "PAGE_RESET",
    z
      .object({
        tabSessionId: sessionIdSchema,
      })
      .strict(),
  ),
  extensionMessageWithPayload(
    "GET_STATUS",
    getInvestigationInputSchema
      .extend({
        tabSessionId: sessionIdSchema.optional(),
      })
      .strict(),
  ),
  extensionMessageWithPayload(
    "INVESTIGATE_NOW",
    z
      .object({
        tabSessionId: sessionIdSchema,
        request: viewPostInputSchema,
      })
      .strict(),
  ),
  ...contentControlMessageSchemas,
  extensionMessageWithoutPayload("GET_CACHED"),
  extensionMessageWithPayload("STATUS_RESPONSE", investigationStatusOutputSchema),
  extensionMessageWithPayload(
    "ANNOTATIONS",
    z.object({ claims: z.array(investigationClaimSchema) }).strict(),
  ),
]);

// ── Public API schemas ────────────────────────────────────────────────────

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
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export const getMetricsInputSchema = z
  .object({
    platform: platformSchema.optional(),
    authorId: z.string().optional(),
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

const publicInvestigationOriginServerVerifiedSchema = z
  .object({
    provenance: z.literal("SERVER_VERIFIED"),
    serverVerifiedAt: z.iso.datetime(),
  })
  .strict();

const publicInvestigationOriginClientFallbackSchema = z
  .object({
    provenance: z.literal("CLIENT_FALLBACK"),
    fetchFailureReason: z.string().min(1),
  })
  .strict();

const publicInvestigationOriginSchema = z.discriminatedUnion("provenance", [
  publicInvestigationOriginServerVerifiedSchema,
  publicInvestigationOriginClientFallbackSchema,
]);

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
          contentHash: z.string().min(1),
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
          contentHash: z.string().min(1),
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
