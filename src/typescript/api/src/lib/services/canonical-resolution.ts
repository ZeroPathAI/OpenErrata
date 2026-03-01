import type { ViewPostInput } from "@openerrata/shared";
import type { CanonicalContentFetchResult, CanonicalFetchInput } from "./content-fetcher.js";

export interface ObservedContentVersion {
  contentText: string;
  contentHash: string;
}

export type CanonicalContentVersion =
  | (ObservedContentVersion & {
      provenance: "SERVER_VERIFIED";
    })
  | (ObservedContentVersion & {
      provenance: "CLIENT_FALLBACK";
      fetchFailureReason: string;
    });

export interface ServerVerifiedContentMismatch {
  platform: ViewPostInput["platform"];
  url: string;
  observedHash: string;
  serverHash: string;
  externalId?: string;
}

type CanonicalFetcher = (input: CanonicalFetchInput) => Promise<CanonicalContentFetchResult>;

function toCanonicalFetchInput(input: ViewPostInput): CanonicalFetchInput {
  if (input.platform === "WIKIPEDIA") {
    return {
      platform: "WIKIPEDIA",
      url: input.url,
      metadata: {
        language: input.metadata.language,
        title: input.metadata.title,
        revisionId: input.metadata.revisionId,
      },
    };
  }

  return {
    platform: input.platform,
    url: input.url,
    externalId: input.externalId,
  };
}

/**
 * Resolves the canonical content version for a post.
 *
 * When the server can independently verify content (e.g. Wikipedia Parse API,
 * LessWrong GraphQL), the server's version is authoritative and is always used
 * regardless of what the client observed. Client-observed content is only used
 * as a fallback when no server-side canonical source is available.
 *
 * Hash mismatches between client-observed and server-verified content are
 * reported via `onServerVerifiedContentMismatch`, but they do not block
 * canonical resolution. The two sources are fundamentally different:
 *   - Client: live browser DOM, which may include JS-injected elements, tracking
 *     pixels, and other browser-specific content outside the article body.
 *   - Server: canonical source API (e.g. Wikipedia Parse API), which returns only
 *     the article body HTML.
 * Requiring strict agreement between them would produce false errors for
 * legitimate page views while providing no meaningful security benefit — the
 * server's independently-
 * fetched canonical version already overrides whatever the client claims to have seen.
 */
export async function resolveCanonicalContentVersion(input: {
  viewInput: ViewPostInput;
  observed: ObservedContentVersion;
  fetchCanonicalContent: CanonicalFetcher;
  onServerVerifiedContentMismatch?: (mismatch: ServerVerifiedContentMismatch) => void;
}): Promise<CanonicalContentVersion> {
  const serverResult = await input.fetchCanonicalContent(toCanonicalFetchInput(input.viewInput));

  if (serverResult.provenance === "SERVER_VERIFIED") {
    if (serverResult.contentHash !== input.observed.contentHash) {
      input.onServerVerifiedContentMismatch?.({
        platform: input.viewInput.platform,
        url: input.viewInput.url,
        observedHash: input.observed.contentHash,
        serverHash: serverResult.contentHash,
        ...("externalId" in input.viewInput ? { externalId: input.viewInput.externalId } : {}),
      });
    }

    return {
      contentText: serverResult.contentText,
      contentHash: serverResult.contentHash,
      provenance: "SERVER_VERIFIED",
    };
  }

  return {
    contentText: input.observed.contentText,
    contentHash: input.observed.contentHash,
    provenance: "CLIENT_FALLBACK",
    fetchFailureReason: serverResult.fetchFailureReason,
  };
}
