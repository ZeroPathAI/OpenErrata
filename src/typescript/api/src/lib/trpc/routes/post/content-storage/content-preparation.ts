import { hashContent, normalizeContent, type ViewPostInput } from "@openerrata/shared";
import { TRPCError } from "@trpc/server";
import { lesswrongHtmlToNormalizedText } from "$lib/services/content-fetcher.js";
import type {
  CanonicalContentVersion,
  ObservedContentVersion,
  ServerVerifiedContentMismatch,
} from "$lib/services/canonical-resolution.js";
import type { PreparedViewPostInput } from "../wikipedia.js";

export function logServerVerifiedContentMismatch(mismatch: ServerVerifiedContentMismatch): void {
  const identity =
    mismatch.externalId === undefined
      ? mismatch.url
      : `externalId=${mismatch.externalId}; url=${mismatch.url}`;

  console.warn(
    `Canonical integrity mismatch for ${mismatch.platform}; continuing with server-verified content. ${identity}; observedHash=${mismatch.observedHash}; serverHash=${mismatch.serverHash}`,
  );
}

export function applyServerVerifiedWikipediaIdentity(input: {
  preparedInput: PreparedViewPostInput;
  canonical: CanonicalContentVersion;
}): PreparedViewPostInput {
  if (
    input.preparedInput.platform !== "WIKIPEDIA" ||
    input.canonical.provenance !== "SERVER_VERIFIED" ||
    input.canonical.canonicalIdentity?.platform !== "WIKIPEDIA"
  ) {
    return input.preparedInput;
  }

  const serverIdentity = input.canonical.canonicalIdentity;
  if (serverIdentity.language !== input.preparedInput.metadata.language) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Wikipedia canonical identity language mismatch between verified fetch and prepared input",
    });
  }

  if (serverIdentity.pageId === input.preparedInput.metadata.pageId) {
    return input.preparedInput;
  }

  console.warn(
    `Wikipedia metadata identity mismatch; continuing with server-verified page identity. url=${input.preparedInput.url}; clientPageId=${input.preparedInput.metadata.pageId}; serverPageId=${serverIdentity.pageId}`,
  );

  return {
    ...input.preparedInput,
    metadata: {
      ...input.preparedInput.metadata,
      pageId: serverIdentity.pageId,
      revisionId: serverIdentity.revisionId,
    },
    derivedExternalId: `${serverIdentity.language}:${serverIdentity.pageId}`,
  };
}

export async function toObservedContentVersion(
  input: ViewPostInput,
): Promise<ObservedContentVersion> {
  const contentText =
    input.platform === "LESSWRONG"
      ? lesswrongHtmlToNormalizedText(input.metadata.htmlContent)
      : normalizeContent(input.observedContentText);
  const contentHash = await hashContent(contentText);
  return { contentText, contentHash };
}
