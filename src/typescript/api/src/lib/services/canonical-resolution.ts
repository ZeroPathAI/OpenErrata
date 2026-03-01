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
 * We do NOT compare the client's observed hash against the server's canonical
 * hash. The two sources are fundamentally different:
 *   - Client: live browser DOM, which may include JS-injected elements, tracking
 *     pixels, and other browser-specific content outside the article body.
 *   - Server: canonical source API (e.g. Wikipedia Parse API), which returns only
 *     the article body HTML.
 * Requiring agreement between them would produce false errors for legitimate page
 * views while providing no meaningful security benefit — the server's independently-
 * fetched canonical version already overrides whatever the client claims to have seen.
 */
export async function resolveCanonicalContentVersion(input: {
  viewInput: ViewPostInput;
  observed: ObservedContentVersion;
  fetchCanonicalContent: CanonicalFetcher;
}): Promise<CanonicalContentVersion> {
  const serverResult = await input.fetchCanonicalContent(toCanonicalFetchInput(input.viewInput));

  if (serverResult.provenance === "SERVER_VERIFIED") {
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
