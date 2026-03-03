import {
  CONTENT_BLOCK_SEPARATOR_TAGS,
  NON_CONTENT_TAGS,
  hashContent,
  isNonNullObject,
  normalizeContent,
  WIKIPEDIA_LANGUAGE_CODE_REGEX,
} from "@openerrata/shared";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import {
  createWikipediaNodeFilter,
  hasChildren,
  isElementNode,
  isTextNode,
  type Parse5NodeFilter,
} from "./wikipedia-content-filter.js";

type ServerFetchResult =
  | {
      success: true;
      contentText: string;
      contentHash: string;
      sourceHtml: string;
      canonicalIdentity: CanonicalIdentity | null;
    }
  | {
      success: false;
      failureReason: string;
    };

export interface CanonicalIdentity {
  platform: "WIKIPEDIA";
  language: string;
  pageId: string;
  revisionId: string;
}

export type CanonicalContentFetchResult =
  | {
      provenance: "SERVER_VERIFIED";
      contentText: string;
      contentHash: string;
      sourceHtml: string;
      canonicalIdentity: CanonicalIdentity | null;
    }
  | {
      provenance: "CLIENT_FALLBACK";
      fetchFailureReason: string;
    };

interface WikipediaCanonicalFetchInput {
  platform: "WIKIPEDIA";
  url: string;
  metadata: {
    language: string;
    title: string;
    pageId: string;
    revisionId: string;
  };
}

/**
 * Canonical fetch contract:
 * - Server-verifiable platforms must carry stable platform identity in the fetch input.
 * - When upstream canonical responses expose authoritative identity, fetchers
 *   should return that identity so callers can correct client-submitted identity.
 */
export type CanonicalFetchInput =
  | {
      platform: "LESSWRONG";
      url: string;
      externalId: string;
    }
  | {
      platform: "X";
      url: string;
      externalId: string;
    }
  | {
      platform: "SUBSTACK";
      url: string;
      externalId: string;
    }
  | WikipediaCanonicalFetchInput;

function describeFetchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether an HTTP status code represents a transient error worth retrying.
 * Retries on 429 (rate limit) and 5xx (server errors).
 */
function isTransientHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const TRANSIENT_RETRY_DELAYS_MS = [200, 400, 800] as const;

/**
 * Fetch wrapper that retries on transient failures (network errors, HTTP 429,
 * HTTP 5xx) with exponential backoff. Non-transient errors (4xx except 429,
 * parse failures) propagate immediately.
 *
 * Returns the successful Response, or throws the last error / returns the
 * last non-ok Response if all attempts fail.
 */
async function fetchWithTransientRetry(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (response.ok || !isTransientHttpStatus(response.status)) {
        return response;
      }
      // Transient HTTP error — retry if attempts remain.
      lastError = new Error(`HTTP ${response.status.toString()}`);
      if (attempt < TRANSIENT_RETRY_DELAYS_MS.length) {
        const delayMs = TRANSIENT_RETRY_DELAYS_MS[attempt];
        if (delayMs !== undefined) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayMs);
          });
        }
        continue;
      }
      return response;
    } catch (error) {
      // Network error — retry if attempts remain.
      lastError = error;
      if (attempt < TRANSIENT_RETRY_DELAYS_MS.length) {
        const delayMs = TRANSIENT_RETRY_DELAYS_MS[attempt];
        if (delayMs !== undefined) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayMs);
          });
        }
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function parseNonNegativeIntegerId(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value.toString();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return value;
  }
  return null;
}

/**
 * Extract the full HTML body from a LessWrong GraphQL response.
 *
 * We use the `html` field rather than `plaintextMainText` because the latter
 * is truncated to 2000 characters by LessWrong's API, which would cause a
 * canonicalization mismatch for any post longer than that.
 */
function extractLesswrongHtml(value: unknown): string | null {
  if (!isNonNullObject(value)) return null;

  const data = value["data"];
  if (!isNonNullObject(data)) return null;

  const post = data["post"];
  if (!isNonNullObject(post)) return null;

  const result = post["result"];
  if (!isNonNullObject(result)) return null;

  const contents = result["contents"];
  if (!isNonNullObject(contents)) return null;

  const html = contents["html"];
  return typeof html === "string" ? html : null;
}

/**
 * Shared parse5 HTML-to-text traversal used by all platform extractors.
 *
 * Performs a stack-based DFS over the parse5 fragment tree, collecting text
 * node values and injecting word-boundary separators at block element edges.
 *
 * Built-in behavior (unconditional):
 *   - `NON_CONTENT_TAGS` (script, style, noscript) are always excluded.
 *
 * Platform-specific filtering:
 *   - An optional `nodeFilter` callback is invoked during the "enter" phase
 *     for every node. Returning `"skip"` omits the node and its subtree.
 */
function parse5HtmlToTextContent(html: string, nodeFilter?: Parse5NodeFilter): string {
  const fragment = parseFragment(html);
  const stack: { node: DefaultTreeAdapterMap["node"]; phase: "enter" | "exit" }[] = [];
  for (let index = fragment.childNodes.length - 1; index >= 0; index -= 1) {
    const child = fragment.childNodes[index];
    if (child !== undefined) {
      stack.push({ node: child, phase: "enter" });
    }
  }

  const chunks: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const { node, phase } = current;

    if (phase === "exit") {
      if (isElementNode(node) && CONTENT_BLOCK_SEPARATOR_TAGS.has(node.tagName.toLowerCase())) {
        chunks.push(" ");
      }
      continue;
    }

    // Universal exclusion: NON_CONTENT_TAGS never contain article prose.
    if (isElementNode(node) && NON_CONTENT_TAGS.has(node.tagName.toLowerCase())) {
      continue;
    }

    // Platform-specific filtering.
    if (nodeFilter !== undefined && nodeFilter(node) === "skip") {
      continue;
    }

    if (isTextNode(node)) {
      chunks.push(node.value);
      continue;
    }

    if (!hasChildren(node)) {
      continue;
    }

    if (isElementNode(node) && CONTENT_BLOCK_SEPARATOR_TAGS.has(node.tagName.toLowerCase())) {
      chunks.push(" ");
    }

    stack.push({ node, phase: "exit" });
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
      const child = node.childNodes[index];
      if (child !== undefined) {
        stack.push({ node: child, phase: "enter" });
      }
    }
  }

  return chunks.join("");
}

/**
 * Convert LessWrong post HTML into normalized plain text for hashing/storage.
 */
export function lesswrongHtmlToNormalizedText(html: string): string {
  return normalizeContent(parse5HtmlToTextContent(html));
}

async function fetchServerVerifiedContent(
  input: CanonicalFetchInput,
): Promise<ServerFetchResult | null> {
  switch (input.platform) {
    case "LESSWRONG":
      return fetchLesswrongContent(input);
    case "WIKIPEDIA":
      return fetchWikipediaContent(input);
    case "X":
    case "SUBSTACK":
      return null;
  }
}

export async function fetchCanonicalContent(
  input: CanonicalFetchInput,
): Promise<CanonicalContentFetchResult> {
  const fetched = await fetchServerVerifiedContent(input);
  if (fetched === null) {
    return {
      provenance: "CLIENT_FALLBACK",
      fetchFailureReason: `${input.platform} canonical server fetch unavailable`,
    };
  }
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
    sourceHtml: fetched.sourceHtml,
    canonicalIdentity: fetched.canonicalIdentity,
  };
}

async function fetchLesswrongContent(
  input: Extract<CanonicalFetchInput, { platform: "LESSWRONG" }>,
): Promise<ServerFetchResult> {
  const postId = input.externalId;
  let response: Response;
  try {
    response = await fetchWithTransientRetry("https://www.lesswrong.com/graphql", {
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
  } catch (error) {
    return {
      success: false,
      failureReason: `LW API request failed: ${describeFetchError(error)}`,
    };
  }

  if (!response.ok) {
    return { success: false, failureReason: `LW API returned ${response.status}` };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    return {
      success: false,
      failureReason: `LW API returned invalid JSON: ${describeFetchError(error)}`,
    };
  }
  const html = extractLesswrongHtml(data);
  if (html === null || html.length === 0) {
    return {
      success: false,
      failureReason: "Could not extract HTML from LW API response",
    };
  }

  const contentText = lesswrongHtmlToNormalizedText(html);
  const contentHash = await hashContent(contentText);
  return { success: true, contentText, contentHash, sourceHtml: html, canonicalIdentity: null };
}

function wikipediaHtmlToTextContent(html: string): string {
  return parse5HtmlToTextContent(html, createWikipediaNodeFilter());
}

export function wikipediaHtmlToNormalizedText(html: string): string {
  return normalizeContent(wikipediaHtmlToTextContent(html));
}

function extractWikipediaParsePayload(value: unknown): {
  html: string;
  pageId: string;
  revisionId: string;
} | null {
  if (!isNonNullObject(value)) return null;
  const parse = value["parse"];
  if (!isNonNullObject(parse)) return null;

  const text = parse["text"];
  const revisionId = parseNonNegativeIntegerId(parse["revid"]);
  const pageId = parseNonNegativeIntegerId(parse["pageid"]);
  if (typeof text !== "string") return null;
  if (revisionId === null || pageId === null) {
    return null;
  }

  return {
    html: text,
    pageId,
    revisionId,
  };
}

async function fetchWikipediaContent(
  input: WikipediaCanonicalFetchInput,
): Promise<ServerFetchResult> {
  const language = input.metadata.language.trim().toLowerCase();
  const pageId = input.metadata.pageId.trim();
  const revisionId = input.metadata.revisionId.trim();
  if (
    language.length === 0 ||
    pageId.length === 0 ||
    revisionId.length === 0 ||
    !WIKIPEDIA_LANGUAGE_CODE_REGEX.test(language) ||
    !/^\d+$/.test(pageId) ||
    !/^\d+$/.test(revisionId)
  ) {
    return {
      success: false,
      failureReason:
        "Wikipedia canonical fetch requires valid language, pageId, and revision metadata",
    };
  }

  const endpoint = new URL(`https://${language}.wikipedia.org/w/api.php`);
  endpoint.searchParams.set("action", "parse");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("formatversion", "2");
  endpoint.searchParams.set("prop", "text|revid");
  endpoint.searchParams.set("oldid", revisionId);

  let response: Response;
  try {
    response = await fetchWithTransientRetry(endpoint);
  } catch (error) {
    return {
      success: false,
      failureReason: `Wikipedia parse request failed: ${describeFetchError(error)}`,
    };
  }
  if (!response.ok) {
    return {
      success: false,
      failureReason: `Wikipedia parse API returned ${response.status}`,
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    return {
      success: false,
      failureReason: `Wikipedia parse API returned invalid JSON: ${describeFetchError(error)}`,
    };
  }
  const payload = extractWikipediaParsePayload(data);
  if (!payload) {
    return {
      success: false,
      failureReason: "Could not extract canonical article HTML from Wikipedia parse response",
    };
  }

  if (payload.revisionId !== revisionId) {
    return {
      success: false,
      failureReason: `Wikipedia parse revision mismatch: expected ${revisionId}, got ${payload.revisionId}`,
    };
  }

  const contentText = wikipediaHtmlToNormalizedText(payload.html);
  const contentHash = await hashContent(contentText);
  return {
    success: true,
    contentText,
    contentHash,
    sourceHtml: payload.html,
    canonicalIdentity: {
      platform: "WIKIPEDIA",
      language,
      pageId: payload.pageId,
      revisionId: payload.revisionId,
    },
  };
}
