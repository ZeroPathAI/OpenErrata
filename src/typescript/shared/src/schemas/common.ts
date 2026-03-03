import { z } from "zod";
import { CONTENT_PROVENANCE_VALUES, PLATFORM_VALUES } from "../enums.js";
import {
  EXTENSION_MESSAGE_PROTOCOL_VERSION,
  MAX_OBSERVED_CONTENT_TEXT_CHARS,
  MAX_OBSERVED_CONTENT_TEXT_UTF8_BYTES,
  MAX_OBSERVED_IMAGE_OCCURRENCES,
} from "../constants.js";

export const platformSchema = z.enum(PLATFORM_VALUES);
export const contentProvenanceSchema = z.enum(CONTENT_PROVENANCE_VALUES);
export const postMediaStateSchema = z.enum(["text_only", "has_images", "has_video"]);

const utf8Encoder = new TextEncoder();

export function utf8ByteLength(input: string): number {
  return utf8Encoder.encode(input).byteLength;
}

export const observedContentTextSchema = z
  .string()
  .min(1)
  .max(MAX_OBSERVED_CONTENT_TEXT_CHARS)
  .refine((value) => utf8ByteLength(value) <= MAX_OBSERVED_CONTENT_TEXT_UTF8_BYTES, {
    message: `Observed content text must be at most ${MAX_OBSERVED_CONTENT_TEXT_UTF8_BYTES.toString()} UTF-8 bytes`,
  });

export const observedImageOccurrenceSchema = z
  .object({
    originalIndex: z.number().int().nonnegative(),
    normalizedTextOffset: z.number().int().nonnegative(),
    sourceUrl: z.url(),
    captionText: z.string().min(1).optional(),
  })
  .strict();

export const observedImageOccurrencesSchema = z
  .array(observedImageOccurrenceSchema)
  .max(MAX_OBSERVED_IMAGE_OCCURRENCES);

export const postIdSchema = z.string().min(1).brand<"PostId">();
export const postVersionIdSchema = z.string().min(1).brand<"PostVersionId">();
export const sessionIdSchema = z.number().int().nonnegative().brand<"SessionId">();
export const investigationIdSchema = z.string().min(1).brand<"InvestigationId">();
export const claimIdSchema = z.string().min(1).brand<"ClaimId">();
export const versionHashSchema = z.string().regex(/^[a-f0-9]{64}$/i);
export const extensionMessageProtocolVersionSchema = z.literal(EXTENSION_MESSAGE_PROTOCOL_VERSION);

export const claimSourceSchema = z
  .object({
    url: z.url(),
    title: z.string().min(1),
    snippet: z.string().min(1),
  })
  .strict();

export const investigationClaimPayloadSchema = z
  .object({
    text: z.string().min(1),
    context: z.string().min(1),
    summary: z.string().min(1),
    reasoning: z.string().min(1),
    sources: z.array(claimSourceSchema).min(1),
  })
  .strict();

export const investigationClaimSchema = investigationClaimPayloadSchema
  .extend({
    id: claimIdSchema,
  })
  .strict();

export const investigationResultSchema = z
  .object({
    claims: z.array(investigationClaimPayloadSchema),
  })
  .strict();

export const WIKIPEDIA_LANGUAGE_CODE_REGEX = /^[a-z][a-z0-9-]*$/i;

export const lesswrongMetadataSchema = z
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

export const xMetadataSchema = z
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

export const substackMetadataSchema = z
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

export const wikipediaMetadataSchema = z
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
