import {
  CONTENT_BLOCK_SEPARATOR_TAGS,
  hashContent,
  isNonNullObject,
  isExcludedWikipediaSectionTitle,
  normalizeContent,
  normalizeWikipediaSectionTitle,
  shouldExcludeWikipediaElement,
  WIKIPEDIA_LANGUAGE_CODE_REGEX,
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
 * CONTENT_MISMATCH for any post longer than that.
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

    // Inject a space before the content of block-level elements so compact HTML
    // (no whitespace text nodes between adjacent block elements) still produces
    // word-separated output after normalizeContent. Mirrors the extension's
    // CONTENT_BLOCK_SEPARATOR_TAGS logic in extractContentWithImageOccurrencesFromRoot.
    if (isElementNode(node) && CONTENT_BLOCK_SEPARATOR_TAGS.has(node.tagName.toLowerCase())) {
      chunks.push(" ");
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

function headingLevelFromTag(tagName: string): number | null {
  const match = /^h([2-6])$/i.exec(tagName);
  if (match?.[1] === undefined || match[1].length === 0) {
    return null;
  }
  return Number(match[1]);
}

/**
 * Returns the direct child element of `node` that is a heading tag (h2–h6),
 * if `node` is a Parsoid-style `<div class="mw-heading">` wrapper.
 * Returns null for all other nodes.
 */
function innerHeadingOfParsoidWrapper(
  node: DefaultTreeAdapterMap["element"],
): DefaultTreeAdapterMap["element"] | null {
  if (node.tagName.toLowerCase() !== "div" || !classTokens(node).includes("mw-heading")) {
    return null;
  }
  for (const child of node.childNodes) {
    if (isElementNode(child) && headingLevelFromTag(child.tagName) !== null) {
      return child;
    }
  }
  return null;
}

/**
 * Returns the heading level of `node`, handling both direct heading elements
 * (`<h2>`, `<h3>`, …) and Parsoid-style `<div class="mw-heading">` wrappers.
 */
function effectiveHeadingLevel(node: DefaultTreeAdapterMap["element"]): number | null {
  const direct = headingLevelFromTag(node.tagName);
  if (direct !== null) return direct;
  const inner = innerHeadingOfParsoidWrapper(node);
  return inner !== null ? headingLevelFromTag(inner.tagName) : null;
}

/**
 * Returns the text to use for section-title exclusion checks. For Parsoid
 * `<div class="mw-heading">` wrappers, reads the inner heading element's
 * text (excluding the sibling `<span class="mw-editsection">`). For direct
 * heading elements, reads their full text content.
 */
function effectiveHeadingText(node: DefaultTreeAdapterMap["element"]): string {
  const inner = innerHeadingOfParsoidWrapper(node);
  return inner !== null ? textContentOfNode(inner) : textContentOfNode(node);
}

function shouldSkipWikipediaElement(node: DefaultTreeAdapterMap["element"]): boolean {
  return shouldExcludeWikipediaElement({
    tagName: node.tagName,
    classTokens: classTokens(node),
  });
}

function wikipediaHtmlToTextContent(html: string): string {
  const fragment = parseFragment(html);
  const stack: {
    node: DefaultTreeAdapterMap["node"];
    phase: "enter" | "exit";
  }[] = [];
  for (let index = fragment.childNodes.length - 1; index >= 0; index -= 1) {
    const child = fragment.childNodes[index];
    if (child !== undefined) {
      stack.push({ node: child, phase: "enter" });
    }
  }

  const chunks: string[] = [];
  let skipSectionLevel: number | null = null;

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

    if (isElementNode(node)) {
      const tagName = node.tagName.toLowerCase();
      const headingLevel = effectiveHeadingLevel(node);
      if (headingLevel !== null) {
        if (skipSectionLevel !== null && headingLevel <= skipSectionLevel) {
          skipSectionLevel = null;
        }

        const headingText = normalizeWikipediaSectionTitle(effectiveHeadingText(node));
        if (isExcludedWikipediaSectionTitle(headingText)) {
          skipSectionLevel = headingLevel;
          continue;
        }
      }

      if (skipSectionLevel !== null || shouldSkipWikipediaElement(node)) {
        continue;
      }

      if (CONTENT_BLOCK_SEPARATOR_TAGS.has(tagName)) {
        chunks.push(" ");
      }

      if (hasChildren(node)) {
        stack.push({ node, phase: "exit" });
        for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
          const child = node.childNodes[index];
          if (child !== undefined) {
            stack.push({ node: child, phase: "enter" });
          }
        }
      }
      continue;
    }

    if (skipSectionLevel !== null) {
      continue;
    }

    if (isTextNode(node)) {
      chunks.push(node.value);
    }
  }

  return chunks.join("");
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
