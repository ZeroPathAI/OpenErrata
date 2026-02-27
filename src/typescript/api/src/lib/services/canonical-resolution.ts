import type { ViewPostInput } from "@openerrata/shared";
import type { CanonicalContentFetchResult, CanonicalFetchInput } from "./content-fetcher.js";

export type ObservedContentVersion = {
  contentText: string;
  contentHash: string;
};

export type CanonicalContentVersion =
  | (ObservedContentVersion & {
      provenance: "SERVER_VERIFIED";
    })
  | (ObservedContentVersion & {
      provenance: "CLIENT_FALLBACK";
      fetchFailureReason: string;
    });

type CanonicalResolutionResult =
  | {
      state: "RESOLVED";
      canonical: CanonicalContentVersion;
    }
  | {
      state: "CONTENT_MISMATCH";
    };

type CanonicalFetcher = (input: CanonicalFetchInput) => Promise<CanonicalContentFetchResult>;

function toCanonicalFetchInput(input: ViewPostInput): CanonicalFetchInput {
  if (input.platform === "WIKIPEDIA") {
    return {
      platform: "WIKIPEDIA",
      url: input.url,
      externalId: input.externalId,
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

export async function resolveCanonicalContentVersion(input: {
  viewInput: ViewPostInput;
  observed: ObservedContentVersion;
  fetchCanonicalContent: CanonicalFetcher;
}): Promise<CanonicalResolutionResult> {
  const serverResult = await input.fetchCanonicalContent(toCanonicalFetchInput(input.viewInput));

  if (serverResult.provenance === "SERVER_VERIFIED") {
    if (serverResult.contentHash !== input.observed.contentHash) {
      return { state: "CONTENT_MISMATCH" };
    }

    return {
      state: "RESOLVED",
      canonical: {
        contentText: serverResult.contentText,
        contentHash: serverResult.contentHash,
        provenance: "SERVER_VERIFIED",
      },
    };
  }

  return {
    state: "RESOLVED",
    canonical: {
      contentText: input.observed.contentText,
      contentHash: input.observed.contentHash,
      provenance: "CLIENT_FALLBACK",
      fetchFailureReason: serverResult.fetchFailureReason,
    },
  };
}
