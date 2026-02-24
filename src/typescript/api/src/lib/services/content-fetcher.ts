import { normalizeContent, hashContent, type Platform } from "@openerrata/shared";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

type ServerFetchResult =
  | {
      success: true;
      contentText: string;
      contentHash: string;
    }
  | {
      success: false;
      failureReason: string;
    };

type CanonicalContentFetchResult =
  | {
      provenance: "SERVER_VERIFIED";
      contentText: string;
      contentHash: string;
    }
  | {
      provenance: "CLIENT_FALLBACK";
      fetchFailureReason: string;
    };

type CanonicalFetchStrategy =
  | {
      capability: "SERVER_VERIFIED";
      fetchContent: (externalId: string) => Promise<ServerFetchResult>;
    }
  | {
      capability: "CLIENT_FALLBACK_ONLY";
      failureReason: string;
    };

const CANONICAL_FETCH_STRATEGIES: Record<Platform, CanonicalFetchStrategy> = {
  LESSWRONG: {
    capability: "SERVER_VERIFIED",
    fetchContent: fetchLesswrongContent,
  },
  X: {
    capability: "CLIENT_FALLBACK_ONLY",
    failureReason: "X canonical server fetch unavailable",
  },
  SUBSTACK: {
    capability: "CLIENT_FALLBACK_ONLY",
    failureReason: "Substack canonical server fetch unavailable",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract the full HTML body from a LessWrong GraphQL response.
 *
 * We use the `html` field rather than `plaintextMainText` because the latter
 * is truncated to 2000 characters by LessWrong's API, which would cause a
 * CONTENT_MISMATCH for any post longer than that.
 */
function extractLesswrongHtml(value: unknown): string | null {
  if (!isRecord(value)) return null;

  const data = value["data"];
  if (!isRecord(data)) return null;

  const post = data["post"];
  if (!isRecord(post)) return null;

  const result = post["result"];
  if (!isRecord(result)) return null;

  const contents = result["contents"];
  if (!isRecord(contents)) return null;

  const html = contents["html"];
  return typeof html === "string" ? html : null;
}

function isTextNode(
  node: DefaultTreeAdapterMap["node"],
): node is DefaultTreeAdapterMap["textNode"] {
  return node.nodeName === "#text";
}

function hasChildren(
  node: DefaultTreeAdapterMap["node"],
): node is DefaultTreeAdapterMap["parentNode"] {
  return "childNodes" in node;
}

function htmlToTextContent(html: string): string {
  const fragment = parseFragment(html);
  const stack: DefaultTreeAdapterMap["node"][] = [];
  for (let index = fragment.childNodes.length - 1; index >= 0; index -= 1) {
    const child = fragment.childNodes[index];
    if (child !== undefined) {
      stack.push(child);
    }
  }

  const chunks: string[] = [];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    if (isTextNode(node)) {
      chunks.push(node.value);
      continue;
    }

    if (!hasChildren(node)) {
      continue;
    }

    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
      const child = node.childNodes[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }

  return chunks.join("");
}

/**
 * Convert LessWrong post HTML into normalized plain text for hashing/storage.
 */
export function lesswrongHtmlToNormalizedText(html: string): string {
  return normalizeContent(htmlToTextContent(html));
}

export async function fetchCanonicalContent(
  platform: Platform,
  _url: string,
  externalId: string,
): Promise<CanonicalContentFetchResult> {
  const strategy = CANONICAL_FETCH_STRATEGIES[platform];
  if (strategy.capability === "CLIENT_FALLBACK_ONLY") {
    return {
      provenance: "CLIENT_FALLBACK",
      fetchFailureReason: strategy.failureReason,
    };
  }

  try {
    const fetched = await strategy.fetchContent(externalId);
    if (!fetched.success) {
      return {
        provenance: "CLIENT_FALLBACK",
        fetchFailureReason: fetched.failureReason,
      };
    }
    return {
      provenance: "SERVER_VERIFIED",
      contentText: fetched.contentText,
      contentHash: fetched.contentHash,
    };
  } catch (error) {
    return {
      provenance: "CLIENT_FALLBACK",
      fetchFailureReason: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function fetchLesswrongContent(postId: string): Promise<ServerFetchResult> {
  const response = await fetch("https://www.lesswrong.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query GetPost($id: String!) {
        post(input: { selector: { _id: $id } }) {
          result {
            _id
            title
            contents {
              html
            }
            user {
              displayName
              slug
            }
          }
        }
      }`,
      variables: { id: postId },
    }),
  });

  if (!response.ok) {
    return { success: false, failureReason: `LW API returned ${response.status}` };
  }

  const data: unknown = await response.json();
  const html = extractLesswrongHtml(data);
  if (!html) {
    return {
      success: false,
      failureReason: "Could not extract HTML from LW API response",
    };
  }

  const contentText = lesswrongHtmlToNormalizedText(html);
  const contentHash = await hashContent(contentText);
  return { success: true, contentText, contentHash };
}
