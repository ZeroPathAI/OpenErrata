import {
  NON_CONTENT_TAGS,
  WORD_SEPARATOR_TAGS,
  hashContent,
  isNonNullObject,
  normalizeContent,
  WIKIPEDIA_LANGUAGE_CODE_REGEX,
} from "@openerrata/shared";
import { setTimeout as sleep } from "node:timers/promises";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
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
      canonicalIdentity: CanonicalIdentity;
    }
  | {
      success: false;
      failureReason: string;
    };

/**
 * Post identity as reported by the platform itself. Identity-bound fields
 * (post URL, author, Wikipedia page/revision) come from here whenever the
 * server fetch succeeds, never from the client (SPEC §2.9).
 */
export type CanonicalIdentity =
  | {
      platform: "LESSWRONG";
      url: string;
      title: string;
      /** Null when LessWrong reports no user for the post (e.g. deleted account). */
      author: { slug: string; displayName: string } | null;
    }
  | {
      platform: "WIKIPEDIA";
      url: string;
      language: string;
      pageId: string;
      revisionId: string;
    };

export type CanonicalContentFetchResult =
  | {
      provenance: "SERVER_VERIFIED";
      contentText: string;
      contentHash: string;
      sourceHtml: string;
      canonicalIdentity: CanonicalIdentity;
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

const LESSWRONG_GRAPHQL_URL = "https://www.lesswrong.com/graphql";

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
 * Wall-clock budget for one canonical fetch, retries included. The fetch runs
 * synchronously inside registerObservedVersion, so a slow or hanging platform
 * must degrade to CLIENT_FALLBACK quickly rather than hold the request open.
 */
const CANONICAL_FETCH_DEADLINE_MS = 10_000;

/** Largest canonical response body we will read (large Wikipedia articles are a few MB). */
const MAX_CANONICAL_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Fetch wrapper that retries on transient failures (network errors, HTTP 429,
 * HTTP 5xx) with exponential backoff, all within one deadline signal.
 * Non-transient errors (4xx except 429) are returned immediately.
 *
 * Returns the first non-transient Response or the last transient one once
 * retries are exhausted; throws the last network error, or the abort reason
 * once the deadline passes.
 */
async function fetchWithTransientRetry(
  input: string | URL,
  init: RequestInit & { signal: AbortSignal },
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const retryDelayMs = TRANSIENT_RETRY_DELAYS_MS[attempt];
    try {
      const response = await fetch(input, init);
      if (response.ok || !isTransientHttpStatus(response.status) || retryDelayMs === undefined) {
        return response;
      }
      await response.body?.cancel();
    } catch (error) {
      if (init.signal.aborted || retryDelayMs === undefined) {
        throw error;
      }
    }
    await sleep(retryDelayMs, undefined, { signal: init.signal });
  }
}

/** Read and JSON-parse a response body, refusing bodies over MAX_CANONICAL_RESPONSE_BYTES. */
async function readJsonWithinLimit(response: Response): Promise<unknown> {
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_CANONICAL_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`response is ${contentLength.toString()} bytes, over the size limit`);
  }
  if (response.body === null) {
    throw new Error("response has no body");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_CANONICAL_RESPONSE_BYTES) {
      await reader.cancel("Canonical response exceeds size limit");
      throw new Error("response body exceeds the size limit");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
 * The parts of a LessWrong GraphQL `post` response we rely on.
 *
 * We use `contents.html` rather than `plaintextMainText` because the latter is
 * truncated to 2000 characters by LessWrong's API, which would cause a
 * canonicalization mismatch for any post longer than that.
 */
const lesswrongPostResponseSchema = z.object({
  data: z.object({
    post: z.object({
      result: z.object({
        _id: z.string().min(1),
        slug: z.string().min(1),
        title: z.string().min(1),
        contents: z.object({ html: z.string().min(1) }),
        user: z.object({ slug: z.string().min(1), displayName: z.string().min(1) }).nullable(),
      }),
    }),
  }),
});

/**
 * Shared parse5 HTML-to-text traversal used by all platform extractors.
 *
 * Performs a stack-based DFS over the parse5 fragment tree, collecting text
 * node values and injecting word-boundary separators at the edges of
 * `WORD_SEPARATOR_TAGS` elements (blocks and line breaks).
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
  const stack: { node: DefaultTreeAdapterMap["childNode"]; phase: "enter" | "exit" }[] = [];
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
      if (isElementNode(node) && WORD_SEPARATOR_TAGS.has(node.tagName.toLowerCase())) {
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

    if (isElementNode(node) && WORD_SEPARATOR_TAGS.has(node.tagName.toLowerCase())) {
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
  const deadline = AbortSignal.timeout(CANONICAL_FETCH_DEADLINE_MS);
  let data: unknown;
  try {
    const response = await fetchWithTransientRetry(LESSWRONG_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query GetPost($id: String!) {
          post(input: { selector: { _id: $id } }) {
            result {
              _id
              slug
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
      signal: deadline,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { success: false, failureReason: `LW API returned ${response.status.toString()}` };
    }
    data = await readJsonWithinLimit(response);
  } catch (error) {
    return {
      success: false,
      failureReason: `LW API request failed: ${describeFetchError(error)}`,
    };
  }

  const parsed = lesswrongPostResponseSchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      failureReason: "Could not extract post content and identity from LW API response",
    };
  }
  const post = parsed.data.data.post.result;
  if (post._id !== postId) {
    return {
      success: false,
      failureReason: `LW API returned post ${post._id} for requested post ${postId}`,
    };
  }

  const contentText = lesswrongHtmlToNormalizedText(post.contents.html);
  const contentHash = await hashContent(contentText);
  return {
    success: true,
    contentText,
    contentHash,
    sourceHtml: post.contents.html,
    canonicalIdentity: {
      platform: "LESSWRONG",
      url: lesswrongPostUrl(post._id, post.slug),
      title: post.title,
      author: post.user,
    },
  };
}

function lesswrongPostUrl(postId: string, slug: string): string {
  return `https://www.lesswrong.com/posts/${encodeURIComponent(postId)}/${encodeURIComponent(slug)}`;
}

/**
 * Article URL for a Wikipedia title as returned by the parse API (spaces, not
 * underscores). Slashes and colons stay literal so subpages and namespaces
 * read naturally; everything else is percent-encoded.
 */
function wikipediaArticleUrl(language: string, title: string): string {
  const encodedTitle = encodeURIComponent(title.replace(/ /g, "_"))
    .replace(/%2F/g, "/")
    .replace(/%3A/g, ":");
  return `https://${language}.wikipedia.org/wiki/${encodedTitle}`;
}

function wikipediaHtmlToTextContent(html: string): string {
  return parse5HtmlToTextContent(html, createWikipediaNodeFilter());
}

export function wikipediaHtmlToNormalizedText(html: string): string {
  return normalizeContent(wikipediaHtmlToTextContent(html));
}

function extractWikipediaParsePayload(value: unknown): {
  html: string;
  title: string;
  pageId: string;
  revisionId: string;
} | null {
  if (!isNonNullObject(value)) return null;
  const parse = value["parse"];
  if (!isNonNullObject(parse)) return null;

  const text = parse["text"];
  const title = parse["title"];
  const revisionId = parseNonNegativeIntegerId(parse["revid"]);
  const pageId = parseNonNegativeIntegerId(parse["pageid"]);
  if (typeof text !== "string" || typeof title !== "string" || title.length === 0) return null;
  if (revisionId === null || pageId === null) {
    return null;
  }

  return {
    html: text,
    title,
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

  const deadline = AbortSignal.timeout(CANONICAL_FETCH_DEADLINE_MS);
  let data: unknown;
  try {
    const response = await fetchWithTransientRetry(endpoint, { signal: deadline });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        success: false,
        failureReason: `Wikipedia parse API returned ${response.status.toString()}`,
      };
    }
    data = await readJsonWithinLimit(response);
  } catch (error) {
    return {
      success: false,
      failureReason: `Wikipedia parse request failed: ${describeFetchError(error)}`,
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
      url: wikipediaArticleUrl(language, payload.title),
      language,
      pageId: payload.pageId,
      revisionId: payload.revisionId,
    },
  };
}
