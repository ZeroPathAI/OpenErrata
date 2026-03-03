import { z } from "zod";
import {
  claimIdSchema,
  contentProvenanceSchema,
  extensionMessageProtocolVersionSchema,
  investigationClaimPayloadSchema,
  investigationClaimSchema,
  investigationIdSchema,
  observedContentTextSchema,
  observedImageOccurrencesSchema,
  platformSchema,
  postIdSchema,
  postMediaStateSchema,
  sessionIdSchema,
  lesswrongMetadataSchema,
  xMetadataSchema,
  substackMetadataSchema,
  wikipediaMetadataSchema,
} from "./common.js";
import {
  getInvestigationInputSchema,
  investigationStatusOutputSchema,
  priorInvestigationResultSchema,
  viewPostInputSchema,
} from "./investigation.js";

const focusClaimPayloadSchema = z
  .object({
    claimId: claimIdSchema,
  })
  .strict();

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
    priorInvestigationResult: priorInvestigationResultSchema.nullable(),
  })
  .strict();

const extensionPostInvestigatingSchema = extensionPostStatusBaseSchema
  .extend({
    investigationState: z.literal("INVESTIGATING"),
    status: z.union([z.literal("PENDING"), z.literal("PROCESSING")]),
    provenance: contentProvenanceSchema,
    pendingClaims: z.array(investigationClaimPayloadSchema),
    confirmedClaims: z.array(investigationClaimPayloadSchema),
    priorInvestigationResult: priorInvestigationResultSchema.nullable(),
  })
  .strict();

const extensionPostFailedSchema = extensionPostStatusBaseSchema
  .extend({
    investigationState: z.literal("FAILED"),
    provenance: contentProvenanceSchema,
  })
  .strict();

const extensionPostApiErrorSchema = extensionPostStatusBaseSchema
  .extend({
    investigationState: z.literal("API_ERROR"),
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
  extensionPostApiErrorSchema,
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
