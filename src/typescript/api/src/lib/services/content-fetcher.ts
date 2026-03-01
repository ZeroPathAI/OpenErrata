import {
  CONTENT_BLOCK_SEPARATOR_TAGS,
  NON_CONTENT_TAGS,
  effectiveHeadingLevel,
  effectiveHeadingText,
  hashContent,
  headingLevelFromTag,
  isNonNullObject,
  isExcludedWikipediaSectionTitle,
  normalizeContent,
  normalizeWikipediaSectionTitle,
  shouldExcludeWikipediaElement,
  WIKIPEDIA_LANGUAGE_CODE_REGEX,
  type WikipediaNodeDescriptor,
} from "@openerrata/shared";
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

export type CanonicalContentFetchResult =
  | {
      provenance: "SERVER_VERIFIED";
      contentText: string;
      contentHash: string;
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
    revisionId: string;
  };
}

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

/**
 * Callback invoked during the "enter" phase of the parse5 DFS traversal.
 * Returning `"skip"` omits the node and its entire subtree from the output.
 * Returning `"include"` processes the node normally.
 *
 * For element nodes, receives the element.
 * For text nodes, receives the text node (allows stateful filters like
 * Wikipedia's section-level skip to suppress text outside of elements).
 */
type Parse5NodeFilter = (node: DefaultTreeAdapterMap["node"]) => "include" | "skip";

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
  };
}

async function fetchLesswrongContent(
  input: Extract<CanonicalFetchInput, { platform: "LESSWRONG" }>,
): Promise<ServerFetchResult> {
  const postId = input.externalId;
  let response: Response;
  try {
    response = await fetch("https://www.lesswrong.com/graphql", {
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
  return { success: true, contentText, contentHash };
}

function isElementNode(
  node: DefaultTreeAdapterMap["node"],
): node is DefaultTreeAdapterMap["element"] {
  return "tagName" in node;
}

function attrValue(node: DefaultTreeAdapterMap["element"], name: string): string | null {
  const match = node.attrs.find((entry) => entry.name === name);
  return match?.value ?? null;
}

function classTokens(node: DefaultTreeAdapterMap["element"]): string[] {
  const classValue = attrValue(node, "class");
  if (classValue === null || classValue.length === 0) return [];
  return classValue
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function firstDirectChildHeadingNode(
  node: DefaultTreeAdapterMap["element"],
): DefaultTreeAdapterMap["element"] | null {
  for (const child of node.childNodes) {
    if (isElementNode(child) && headingLevelFromTag(child.tagName) !== null) {
      return child;
    }
  }
  return null;
}

function toFirstChildHeadingDescriptor(
  firstChildHeadingNode: DefaultTreeAdapterMap["element"] | null,
  includeHeadingTextContent: boolean,
): WikipediaNodeDescriptor["firstChildHeading"] {
  if (firstChildHeadingNode === null) {
    return null;
  }

  return {
    tagName: firstChildHeadingNode.tagName,
    textContent: includeHeadingTextContent ? textContentOfNode(firstChildHeadingNode) : "",
  };
}

function textContentOfNode(node: DefaultTreeAdapterMap["node"]): string {
  if (isTextNode(node)) {
    return node.value;
  }

  if (!hasChildren(node)) {
    return "";
  }

  let text = "";
  for (const child of node.childNodes) {
    text += textContentOfNode(child);
  }
  return text;
}

/**
 * Build a WikipediaNodeDescriptor from a parse5 element for shared heading logic.
 *
 * This helper is intentionally configurable so callers can avoid expensive
 * subtree text scans when they only need heading level (not heading text).
 */
function toNodeDescriptor(input: {
  node: DefaultTreeAdapterMap["element"];
  classTokenValues: readonly string[];
  firstChildHeadingNode: DefaultTreeAdapterMap["element"] | null;
  includeNodeTextContent: boolean;
  includeFirstChildHeadingTextContent: boolean;
}): WikipediaNodeDescriptor {
  return {
    tagName: input.node.tagName,
    classTokens: input.classTokenValues,
    textContent: input.includeNodeTextContent ? textContentOfNode(input.node) : "",
    firstChildHeading: toFirstChildHeadingDescriptor(
      input.firstChildHeadingNode,
      input.includeFirstChildHeadingTextContent,
    ),
  };
}

function shouldSkipWikipediaElement(node: DefaultTreeAdapterMap["element"]): boolean {
  return shouldExcludeWikipediaElement({
    tagName: node.tagName,
    classTokens: classTokens(node),
  });
}

/**
 * Creates a stateful node filter for Wikipedia content extraction.
 *
 * Handles section-level exclusion (e.g. "References", "External links") and
 * element-level exclusion (e.g. citation superscripts, edit-section links)
 * via `shouldExcludeWikipediaElement`. Text nodes are suppressed when inside
 * an excluded section.
 *
 * NON_CONTENT_TAGS (script/style/noscript) are already excluded by
 * `parse5HtmlToTextContent` before this filter runs, so
 * `shouldExcludeWikipediaElement`'s tag check is redundant but harmless.
 */
function createWikipediaNodeFilter(): Parse5NodeFilter {
  let skipSectionLevel: number | null = null;

  return (node: DefaultTreeAdapterMap["node"]): "include" | "skip" => {
    if (isElementNode(node)) {
      const classTokenValues = classTokens(node);
      const firstChildHeadingNode = firstDirectChildHeadingNode(node);
      const descriptor = toNodeDescriptor({
        node,
        classTokenValues,
        firstChildHeadingNode,
        includeNodeTextContent: false,
        includeFirstChildHeadingTextContent: false,
      });
      const nodeHeadingLevel = effectiveHeadingLevel(descriptor);
      if (nodeHeadingLevel !== null) {
        if (skipSectionLevel !== null && nodeHeadingLevel <= skipSectionLevel) {
          skipSectionLevel = null;
        }

        const headingText = normalizeWikipediaSectionTitle(
          effectiveHeadingText(
            toNodeDescriptor({
              node,
              classTokenValues,
              firstChildHeadingNode,
              includeNodeTextContent: true,
              includeFirstChildHeadingTextContent: true,
            }),
          ),
        );
        if (isExcludedWikipediaSectionTitle(headingText)) {
          skipSectionLevel = nodeHeadingLevel;
          return "skip";
        }
      }

      if (skipSectionLevel !== null || shouldSkipWikipediaElement(node)) {
        return "skip";
      }

      return "include";
    }

    // Text nodes: suppress when inside an excluded section.
    if (skipSectionLevel !== null) {
      return "skip";
    }

    return "include";
  };
}

function wikipediaHtmlToTextContent(html: string): string {
  return parse5HtmlToTextContent(html, createWikipediaNodeFilter());
}

export function wikipediaHtmlToNormalizedText(html: string): string {
  return normalizeContent(wikipediaHtmlToTextContent(html));
}

function extractWikipediaParsePayload(value: unknown): {
  html: string;
  revisionId: string;
} | null {
  if (!isNonNullObject(value)) return null;
  const parse = value["parse"];
  if (!isNonNullObject(parse)) return null;

  const text = parse["text"];
  const rawRevisionId = parse["revid"];
  if (typeof text !== "string") return null;
  if (
    typeof rawRevisionId !== "number" &&
    !(typeof rawRevisionId === "string" && /^\d+$/.test(rawRevisionId))
  ) {
    return null;
  }

  return {
    html: text,
    revisionId: String(rawRevisionId),
  };
}

async function fetchWikipediaContent(
  input: WikipediaCanonicalFetchInput,
): Promise<ServerFetchResult> {
  const language = input.metadata.language.trim().toLowerCase();
  const revisionId = input.metadata.revisionId.trim();
  if (
    language.length === 0 ||
    revisionId.length === 0 ||
    !WIKIPEDIA_LANGUAGE_CODE_REGEX.test(language)
  ) {
    return {
      success: false,
      failureReason: "Wikipedia canonical fetch requires valid language and revision metadata",
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
    response = await fetch(endpoint);
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
  return { success: true, contentText, contentHash };
}
