import { z } from "zod";
import {
  contentProvenanceSchema,
  investigationClaimPayloadSchema,
  investigationClaimSchema,
  investigationIdSchema,
  lesswrongMetadataSchema,
  observedContentTextSchema,
  observedImageOccurrencesSchema,
  platformSchema,
  postIdSchema,
  postVersionIdSchema,
  substackMetadataSchema,
  versionHashSchema,
  wikipediaMetadataSchema,
  xMetadataSchema,
} from "./common.js";

const versionedPostInputSharedSchema = z
  .object({
    url: z.url(),
    // Every image the client observed, in page order. This is the only image
    // representation on the wire; the unique image URL list is derived from it
    // (`observedImageUrlsFromOccurrences`). Omitted means no images were observed.
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

/**
 * Status of the investigation (if any) for one post version, as returned by
 * `recordViewAndGetStatus`. Every variant that refers to an existing
 * investigation carries its id, so a client that did not start the
 * investigation itself can still poll `getInvestigation` for progress.
 */
export const viewPostOutputSchema = z.discriminatedUnion("investigationState", [
  investigationStatusNotInvestigatedSchema,
  investigationStatusInvestigatingSchema
    .extend({ investigationId: investigationIdSchema })
    .strict(),
  investigationStatusFailedSchema.extend({ investigationId: investigationIdSchema }).strict(),
  investigationStatusInvestigatedSchema.extend({ investigationId: investigationIdSchema }).strict(),
]);

export const getInvestigationInputSchema = z
  .object({
    investigationId: investigationIdSchema,
  })
  .strict();

// `checkedAt` is set iff an investigation is COMPLETE (DB invariant
// INV-INV-CHECKED-AT-CONSISTENCY), so only the INVESTIGATED variant carries it.
export const getInvestigationOutputSchema = z.discriminatedUnion("investigationState", [
  investigationStatusNotInvestigatedSchema,
  investigationStatusInvestigatingSchema,
  investigationStatusFailedSchema,
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
