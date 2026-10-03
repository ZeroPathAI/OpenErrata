/**
 * Message protocol between the extension's contexts (spec §3.8.1). Every
 * message is `{ type, payload }`; every reply is a response envelope
 * (`{ ok: true, value }` or an `{ ok: false, error }` runtime error). Each
 * direction has one request map from message type to payload and response
 * schemas — the single table both senders and handlers are typed from, and
 * that receivers validate incoming payloads against.
 *
 * - `BACKGROUND_REQUESTS`: content script / popup → background
 *   (`runtime.sendMessage`).
 * - `CONTENT_REQUESTS`: background / popup → a tab's content script
 *   (`tabs.sendMessage`).
 *
 * All contexts ship in one extension bundle, so the protocol is not versioned:
 * a content script orphaned by an extension update can no longer reach the new
 * background at all. API compatibility is versioned separately, over HTTP
 * (`x-openerrata-extension-version`, spec §3.3).
 */
import { z } from "zod";
import {
  claimIdSchema,
  contentProvenanceSchema,
  investigationClaimPayloadSchema,
  investigationClaimSchema,
  investigationIdSchema,
  lesswrongExternalIdSchema,
  lesswrongMetadataSchema,
  observedContentTextSchema,
  observedImageOccurrencesSchema,
  platformSchema,
  postIdSchema,
  substackExternalIdSchema,
  substackMetadataSchema,
  tabSessionIdSchema,
  wikipediaExternalIdSchema,
  wikipediaMetadataSchema,
  xExternalIdSchema,
  xMetadataSchema,
} from "./common.js";
import { priorInvestigationResultSchema } from "./investigation.js";

// ── Observed page content ─────────────────────────────────────────────────

const platformContentBaseSchema = z
  .object({
    url: z.url(),
    // Normalized plain text as observed by the client. Textless content is
    // skipped (`no_text`) before it is ever sent.
    contentText: observedContentTextSchema,
    // Video makes a post non-analyzable; images do not (spec §2.4.2).
    hasVideo: z.boolean(),
    // Every observed image, in page order. The single source of image data:
    // image URLs and "has images" are derived from it.
    imageOccurrences: observedImageOccurrencesSchema,
  })
  .strict();

export const platformContentSchema = z.discriminatedUnion("platform", [
  platformContentBaseSchema
    .extend({
      platform: z.literal("LESSWRONG"),
      externalId: lesswrongExternalIdSchema,
      metadata: lesswrongMetadataSchema,
    })
    .strict(),
  platformContentBaseSchema
    .extend({
      platform: z.literal("X"),
      externalId: xExternalIdSchema,
      metadata: xMetadataSchema,
    })
    .strict(),
  platformContentBaseSchema
    .extend({
      platform: z.literal("SUBSTACK"),
      externalId: substackExternalIdSchema,
      metadata: substackMetadataSchema,
    })
    .strict(),
  platformContentBaseSchema
    .extend({
      platform: z.literal("WIKIPEDIA"),
      externalId: wikipediaExternalIdSchema,
      metadata: wikipediaMetadataSchema,
    })
    .strict(),
]);

// ── Per-tab page status (background cache, popup, content script) ─────────

const extensionPostStatusBaseSchema = z
  .object({
    kind: z.literal("POST"),
    tabSessionId: tabSessionIdSchema,
    platform: platformSchema,
    externalId: postIdSchema,
    pageUrl: z.url(),
  })
  .strict();

export const extensionPostStatusSchema = z.discriminatedUnion("investigationState", [
  extensionPostStatusBaseSchema
    .extend({
      investigationState: z.literal("NOT_INVESTIGATED"),
      priorInvestigationResult: priorInvestigationResultSchema.nullable(),
    })
    .strict(),
  extensionPostStatusBaseSchema
    .extend({
      investigationState: z.literal("INVESTIGATING"),
      investigationId: investigationIdSchema,
      status: z.union([z.literal("PENDING"), z.literal("PROCESSING")]),
      provenance: contentProvenanceSchema,
      pendingClaims: z.array(investigationClaimPayloadSchema),
      confirmedClaims: z.array(investigationClaimPayloadSchema),
      priorInvestigationResult: priorInvestigationResultSchema.nullable(),
    })
    .strict(),
  extensionPostStatusBaseSchema
    .extend({
      investigationState: z.literal("FAILED"),
      investigationId: investigationIdSchema,
      provenance: contentProvenanceSchema,
    })
    .strict(),
  // The extension could not obtain a status from the API (network failure,
  // incompatible extension version, invalid settings, ...). Unlike FAILED,
  // this says nothing about any server-side investigation.
  extensionPostStatusBaseSchema
    .extend({
      investigationState: z.literal("API_ERROR"),
    })
    .strict(),
  extensionPostStatusBaseSchema
    .extend({
      investigationState: z.literal("INVESTIGATED"),
      investigationId: investigationIdSchema,
      provenance: contentProvenanceSchema,
      claims: z.array(investigationClaimSchema),
    })
    .strict(),
]);

/** Skip reasons, spec §3.8 "All skip reasons". */
const extensionSkippedReasonSchema = z.enum([
  "has_video",
  "word_count",
  "no_text",
  "private_or_gated",
  "unsupported_content",
]);

/**
 * A supported page the extension deliberately does not send to the API.
 * Skipped pages are identified by URL only: a skip can happen before the
 * platform's post ID is known (e.g. a Substack paywall or an unrenderable
 * tweet), so no external ID is reported for them.
 */
const extensionSkippedStatusSchema = z
  .object({
    kind: z.literal("SKIPPED"),
    tabSessionId: tabSessionIdSchema,
    platform: platformSchema,
    pageUrl: z.url(),
    reason: extensionSkippedReasonSchema,
  })
  .strict();

export const extensionPageStatusSchema = z.discriminatedUnion("kind", [
  extensionPostStatusSchema,
  extensionSkippedStatusSchema,
]);

// ── Responses ─────────────────────────────────────────────────────────────

export const extensionRuntimeErrorCodeSchema = z.enum([
  "PAYLOAD_TOO_LARGE",
  "UPGRADE_REQUIRED",
  "MALFORMED_EXTENSION_VERSION",
  "INVALID_EXTENSION_MESSAGE",
  // Stored settings are unusable (invalid API URL, or no host permission for
  // it); retrying cannot help until the user fixes them in the options page.
  "INVALID_EXTENSION_SETTINGS",
]);

const extensionRuntimeErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    error: z.string().min(1),
    errorCode: extensionRuntimeErrorCodeSchema.optional(),
  })
  .strict();

function extensionResponseEnvelopeSchema<TValue extends z.ZodType>(value: TValue) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }).strict(),
    extensionRuntimeErrorResponseSchema,
  ]);
}

const annotationVisibilitySchema = z.object({ visible: z.boolean() }).strict();

/** Whether the popup may show a status for the tab, or must show an upgrade notice. */
const tabStatusResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("UPGRADE_REQUIRED"), message: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("STATUS"), status: extensionPageStatusSchema.nullable() }).strict(),
]);

// ── Request maps ──────────────────────────────────────────────────────────

interface RequestDefinition {
  payload: z.ZodType;
  response: z.ZodType;
}

export const BACKGROUND_REQUESTS = {
  /** A tracked post's content; returns the status cached for that page session. */
  PAGE_CONTENT: {
    payload: z
      .object({ tabSessionId: tabSessionIdSchema, content: platformContentSchema })
      .strict(),
    response: extensionPostStatusSchema,
  },
  PAGE_SKIPPED: {
    payload: extensionSkippedStatusSchema.omit({ kind: true }).strict(),
    response: z.null(),
  },
  /** The page session ended (navigation or new content); its status is discarded. */
  PAGE_RESET: {
    payload: z.object({ tabSessionId: tabSessionIdSchema }).strict(),
    response: z.null(),
  },
  INVESTIGATE_NOW: {
    payload: z
      .object({ tabSessionId: tabSessionIdSchema, content: platformContentSchema })
      .strict(),
    response: extensionPostStatusSchema,
  },
  /** Popup read of a tab's cached status. */
  GET_TAB_STATUS: {
    payload: z.object({ tabId: z.number().int().nonnegative() }).strict(),
    response: tabStatusResponseSchema,
  },
} as const satisfies Record<string, RequestDefinition>;

export const CONTENT_REQUESTS = {
  /** Liveness probe; must have no side effects. */
  PING: { payload: z.null(), response: z.object({ alive: z.literal(true) }).strict() },
  /** Pure read of highlight visibility; must have no side effects. */
  GET_VISIBILITY: { payload: z.null(), response: annotationVisibilitySchema },
  SHOW_ANNOTATIONS: { payload: z.null(), response: annotationVisibilitySchema },
  HIDE_ANNOTATIONS: { payload: z.null(), response: annotationVisibilitySchema },
  /** Investigate the post in the current page session; `ok: false` when there is none. */
  REQUEST_INVESTIGATE: { payload: z.null(), response: z.object({ ok: z.boolean() }).strict() },
  FOCUS_CLAIM: {
    payload: z.object({ claimId: claimIdSchema }).strict(),
    response: z.object({ ok: z.boolean() }).strict(),
  },
  /**
   * The page changed its URL through the History API. Content scripts run in
   * an isolated world and cannot observe the page's `pushState` calls, so the
   * background relays `webNavigation.onHistoryStateUpdated`.
   */
  LOCATION_CHANGED: { payload: z.null(), response: z.null() },
  /** The background cached a new status for this tab. */
  STATUS_CHANGED: {
    payload: z.object({ status: extensionPageStatusSchema }).strict(),
    response: z.null(),
  },
} as const satisfies Record<string, RequestDefinition>;

type BackgroundRequests = typeof BACKGROUND_REQUESTS;
type ContentRequests = typeof CONTENT_REQUESTS;

/** Outcome of validating an incoming message part against the protocol. */
export type ProtocolParseResult<Value> =
  | { success: true; data: Value }
  | { success: false; error: string };

export type ExtensionRuntimeErrorResponse = z.infer<typeof extensionRuntimeErrorResponseSchema>;

/** A response envelope whose `ok: true` value has been validated. */
export type ProtocolResponseEnvelope<Value> =
  | { ok: true; value: Value }
  | ExtensionRuntimeErrorResponse;

// The helpers below validate against the schema registered for `type`. The
// compiler cannot relate the (union-typed) parse result back to the generic
// `Type`, so each states that relation once, right after validation.

export function parseBackgroundRequestPayload<Type extends keyof BackgroundRequests>(
  type: Type,
  payload: unknown,
): ProtocolParseResult<z.output<BackgroundRequests[Type]["payload"]>> {
  const result = BACKGROUND_REQUESTS[type].payload.safeParse(payload);
  if (!result.success) return { success: false, error: result.error.message };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by the schema registered for `type`
  return { success: true, data: result.data as z.output<BackgroundRequests[Type]["payload"]> };
}

export function parseBackgroundResponseEnvelope<Type extends keyof BackgroundRequests>(
  type: Type,
  response: unknown,
): ProtocolParseResult<ProtocolResponseEnvelope<z.output<BackgroundRequests[Type]["response"]>>> {
  const result = extensionResponseEnvelopeSchema(BACKGROUND_REQUESTS[type].response).safeParse(
    response,
  );
  if (!result.success) return { success: false, error: result.error.message };
  if (!result.data.ok) return { success: true, data: result.data };
  return {
    success: true,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by the schema registered for `type`
    data: { ok: true, value: result.data.value as z.output<BackgroundRequests[Type]["response"]> },
  };
}

export function parseContentRequestPayload<Type extends keyof ContentRequests>(
  type: Type,
  payload: unknown,
): ProtocolParseResult<z.output<ContentRequests[Type]["payload"]>> {
  const result = CONTENT_REQUESTS[type].payload.safeParse(payload);
  if (!result.success) return { success: false, error: result.error.message };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by the schema registered for `type`
  return { success: true, data: result.data as z.output<ContentRequests[Type]["payload"]> };
}

export function parseContentResponseEnvelope<Type extends keyof ContentRequests>(
  type: Type,
  response: unknown,
): ProtocolParseResult<ProtocolResponseEnvelope<z.output<ContentRequests[Type]["response"]>>> {
  const result = extensionResponseEnvelopeSchema(CONTENT_REQUESTS[type].response).safeParse(
    response,
  );
  if (!result.success) return { success: false, error: result.error.message };
  if (!result.data.ok) return { success: true, data: result.data };
  return {
    success: true,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by the schema registered for `type`
    data: { ok: true, value: result.data.value as z.output<ContentRequests[Type]["response"]> },
  };
}
