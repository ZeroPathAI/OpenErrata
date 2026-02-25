import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXTENSION_MESSAGE_PROTOCOL_VERSION,
  MAX_OBSERVED_CONTENT_TEXT_CHARS,
} from "../../src/constants.js";
import {
  contentControlMessageSchema,
  extensionMessageProtocolVersionSchema,
  extensionSkippedStatusSchema,
  extensionPostStatusSchema,
  extensionMessageSchema,
  extensionRuntimeErrorResponseSchema,
  claimIdSchema,
  investigationIdSchema,
  investigationClaimSchema,
  platformContentSchema,
  postIdSchema,
  sessionIdSchema,
  viewPostInputSchema,
} from "../../src/schemas.js";
import type {
  ExtensionMessageProtocolVersion,
  ClaimId,
  InvestigationId,
  PostId,
  SessionId,
} from "../../src/types.js";

function createLesswrongContent() {
  return {
    platform: "LESSWRONG" as const,
    externalId: "lw-123",
    url: "https://www.lesswrong.com/posts/abc123/example",
    contentText: "Example post content",
    mediaState: "text_only",
    imageUrls: [],
    metadata: {
      slug: "example-post",
      htmlContent: "<p>Example post content</p>",
      tags: ["rationality"],
    },
  };
}

function createXContent() {
  return {
    platform: "X" as const,
    externalId: "x-123",
    url: "https://x.com/example/status/123",
    contentText: "Example tweet content",
    mediaState: "has_images",
    imageUrls: ["https://example.com/image.png"],
    metadata: {
      authorHandle: "example",
      text: "Example tweet content",
      mediaUrls: ["https://example.com/image.png"],
      likeCount: 10,
      retweetCount: 2,
    },
  };
}

function createSubstackContent() {
  return {
    platform: "SUBSTACK" as const,
    externalId: "substack-123",
    url: "https://example.substack.com/p/example-post",
    contentText: "Example Substack post content",
    mediaState: "text_only",
    imageUrls: [],
    metadata: {
      substackPostId: "12345",
      publicationSubdomain: "example",
      slug: "example-post",
      title: "Example post",
      authorName: "Example Author",
      likeCount: 10,
      commentCount: 2,
    },
  };
}

test("platformContentSchema parses valid LESSWRONG, X, and SUBSTACK payloads", () => {
  const lesswrongPayload = createLesswrongContent();
  const xPayload = createXContent();
  const substackPayload = createSubstackContent();

  assert.deepEqual(platformContentSchema.parse(lesswrongPayload), lesswrongPayload);
  assert.deepEqual(platformContentSchema.parse(xPayload), xPayload);
  assert.deepEqual(platformContentSchema.parse(substackPayload), substackPayload);
});

test("platformContentSchema rejects empty normalized contentText", () => {
  const xPayload = createXContent();
  const payload = {
    ...xPayload,
    contentText: "",
  };

  const result = platformContentSchema.safeParse(payload);
  assert.equal(result.success, false);
});

test("viewPostInputSchema enforces observedContentText max length", () => {
  const tooLongInput = {
    platform: "X" as const,
    externalId: "x-too-long",
    url: "https://x.com/example/status/too-long",
    observedContentText: "a".repeat(MAX_OBSERVED_CONTENT_TEXT_CHARS + 1),
    metadata: {
      authorHandle: "example",
      text: "a".repeat(MAX_OBSERVED_CONTENT_TEXT_CHARS + 1),
      mediaUrls: [],
    },
  };

  const result = viewPostInputSchema.safeParse(tooLongInput);
  assert.equal(result.success, false);
});

test("viewPostInputSchema allows LessWrong payloads without observedContentText", () => {
  const lesswrongInput = {
    platform: "LESSWRONG" as const,
    externalId: "lw-without-observed",
    url: "https://www.lesswrong.com/posts/abc123/example",
    metadata: {
      slug: "example-post",
      htmlContent: "<p>Example post content</p>",
      tags: ["rationality"],
    },
  };

  const result = viewPostInputSchema.safeParse(lesswrongInput);
  assert.equal(result.success, true);
});

test("viewPostInputSchema rejects LessWrong payloads with observedContentText", () => {
  const lesswrongInputWithObserved = {
    platform: "LESSWRONG" as const,
    externalId: "lw-with-observed",
    url: "https://www.lesswrong.com/posts/abc123/example",
    observedContentText: "unexpected observed text",
    metadata: {
      slug: "example-post",
      htmlContent: "<p>Example post content</p>",
      tags: ["rationality"],
    },
  };

  const result = viewPostInputSchema.safeParse(lesswrongInputWithObserved);
  assert.equal(result.success, false);
});

test("viewPostInputSchema requires observedContentText for X payloads", () => {
  const xInputMissingObserved = {
    platform: "X" as const,
    externalId: "x-missing-observed",
    url: "https://x.com/example/status/x-missing-observed",
    metadata: {
      authorHandle: "example",
      text: "Example tweet content",
      mediaUrls: [],
    },
  };

  const result = viewPostInputSchema.safeParse(xInputMissingObserved);
  assert.equal(result.success, false);
});

test("extensionSkippedStatusSchema accepts no_text skip reason", () => {
  const parsed = extensionSkippedStatusSchema.parse({
    kind: "SKIPPED",
    tabSessionId: 1,
    platform: "X",
    externalId: "x-no-text",
    pageUrl: "https://x.com/example/status/x-no-text",
    reason: "no_text",
  });

  assert.equal(parsed.reason, "no_text");
});

test("extensionSkippedStatusSchema accepts private_or_gated skip reason", () => {
  const parsed = extensionSkippedStatusSchema.parse({
    kind: "SKIPPED",
    tabSessionId: 1,
    platform: "SUBSTACK",
    externalId: "paid-post",
    pageUrl: "https://example.substack.com/p/paid-post",
    reason: "private_or_gated",
  });

  assert.equal(parsed.reason, "private_or_gated");
});

test("extensionPostStatusSchema accepts CONTENT_MISMATCH state", () => {
  const parsed = extensionPostStatusSchema.parse({
    kind: "POST",
    tabSessionId: 1,
    platform: "LESSWRONG",
    externalId: "lw-content-mismatch",
    pageUrl: "https://www.lesswrong.com/posts/abc123/example",
    investigationState: "CONTENT_MISMATCH",
    claims: null,
  });

  assert.equal(parsed.investigationState, "CONTENT_MISMATCH");
});

test("platformContentSchema rejects LESSWRONG payloads missing htmlContent", () => {
  const lesswrongPayload = createLesswrongContent();
  const { htmlContent, ...metadataWithoutHtml } = lesswrongPayload.metadata;
  void htmlContent;

  const result = platformContentSchema.safeParse({
    ...lesswrongPayload,
    metadata: metadataWithoutHtml,
  });

  assert.equal(result.success, false);
});

test("investigationClaimSchema rejects invalid claim payloads", () => {
  const emptySources = investigationClaimSchema.safeParse({
    id: "claim-1",
    text: "Claim text",
    context: "Claim context",
    summary: "Claim summary",
    reasoning: "Claim reasoning",
    sources: [],
  });

  const emptyReasoning = investigationClaimSchema.safeParse({
    id: "claim-1",
    text: "Claim text",
    context: "Claim context",
    summary: "Claim summary",
    reasoning: "",
    sources: [
      {
        url: "https://example.com/source",
        title: "Source",
        snippet: "Source snippet",
      },
    ],
  });

  assert.equal(emptySources.success, false);
  assert.equal(emptyReasoning.success, false);
});

test("contentControlMessageSchema accepts FOCUS_CLAIM with claimId", () => {
  const parsed = contentControlMessageSchema.parse({
    v: EXTENSION_MESSAGE_PROTOCOL_VERSION,
    type: "FOCUS_CLAIM",
    payload: {
      claimId: "claim-123",
    },
  });

  assert.equal(parsed.type, "FOCUS_CLAIM");
  assert.equal("claimId" in parsed.payload, true);
  if ("claimId" in parsed.payload) {
    assert.equal(parsed.payload.claimId, "claim-123");
  }
});

test("contentControlMessageSchema rejects FOCUS_CLAIM claimIndex payload", () => {
  const parsed = contentControlMessageSchema.safeParse({
    v: EXTENSION_MESSAGE_PROTOCOL_VERSION,
    type: "FOCUS_CLAIM",
    payload: {
      claimIndex: 0,
    },
  });

  assert.equal(parsed.success, false);
});

test("extensionMessageSchema rejects FOCUS_CLAIM with claimIndex payload", () => {
  const parsed = extensionMessageSchema.safeParse({
    v: EXTENSION_MESSAGE_PROTOCOL_VERSION,
    type: "FOCUS_CLAIM",
    payload: {
      claimIndex: -1,
    },
  });

  assert.equal(parsed.success, false);
});

test("extensionMessageSchema rejects FOCUS_CLAIM with empty claimId", () => {
  const parsed = extensionMessageSchema.safeParse({
    v: EXTENSION_MESSAGE_PROTOCOL_VERSION,
    type: "FOCUS_CLAIM",
    payload: {
      claimId: "",
    },
  });

  assert.equal(parsed.success, false);
});

test("extensionMessageSchema rejects messages without protocol version", () => {
  const parsed = extensionMessageSchema.safeParse({
    type: "GET_CACHED",
  });

  assert.equal(parsed.success, false);
});

test("extensionMessageSchema rejects unexpected protocol versions", () => {
  const parsed = extensionMessageSchema.safeParse({
    v: EXTENSION_MESSAGE_PROTOCOL_VERSION + 1,
    type: "GET_CACHED",
  });

  assert.equal(parsed.success, false);
});

test("branded identifier schemas parse valid inputs and expose branded types", () => {
  const postId: PostId = postIdSchema.parse("post-123");
  const sessionId: SessionId = sessionIdSchema.parse(7);
  const investigationId: InvestigationId = investigationIdSchema.parse("inv-123");
  const claimId: ClaimId = claimIdSchema.parse("claim-123");
  const protocolVersion: ExtensionMessageProtocolVersion =
    extensionMessageProtocolVersionSchema.parse(
      EXTENSION_MESSAGE_PROTOCOL_VERSION,
    );

  assert.equal(postId, "post-123");
  assert.equal(sessionId, 7);
  assert.equal(investigationId, "inv-123");
  assert.equal(claimId, "claim-123");
  assert.equal(protocolVersion, EXTENSION_MESSAGE_PROTOCOL_VERSION);
});

test("extensionRuntimeErrorResponseSchema accepts structured mismatch code", () => {
  const parsed = extensionRuntimeErrorResponseSchema.parse({
    ok: false,
    error: "Request failed",
    errorCode: "CONTENT_MISMATCH",
  });

  assert.equal(parsed.errorCode, "CONTENT_MISMATCH");
});

test("extensionRuntimeErrorResponseSchema rejects unknown error codes", () => {
  const parsed = extensionRuntimeErrorResponseSchema.safeParse({
    ok: false,
    error: "Request failed",
    errorCode: "SOMETHING_ELSE",
  });

  assert.equal(parsed.success, false);
});
