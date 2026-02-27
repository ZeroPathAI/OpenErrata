import {
  hashContent,
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

type WikipediaCanonicalFetchInput = {
  platform: "WIKIPEDIA";
  url: string;
  externalId: string;
  metadata: {
    language: string;
    title: string;
    revisionId: string;
  };
};

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
  try {
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
  } catch (error) {
    return {
      provenance: "CLIENT_FALLBACK",
      fetchFailureReason: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function fetchLesswrongContent(
  input: Extract<CanonicalFetchInput, { platform: "LESSWRONG" }>,
): Promise<ServerFetchResult> {
  const postId = input.externalId;
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

const WIKIPEDIA_BLOCK_TAGS = new Set([
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "figcaption",
  "blockquote",
  "tr",
  "td",
  "th",
  "div",
]);

function headingLevelFromTag(tagName: string): number | null {
  const match = tagName.match(/^h([2-6])$/i);
  if (match?.[1] === undefined || match[1].length === 0) {
    return null;
  }
  return Number(match[1]);
}

function shouldSkipWikipediaElement(node: DefaultTreeAdapterMap["element"]): boolean {
  return shouldExcludeWikipediaElement({
    tagName: node.tagName,
    classTokens: classTokens(node),
  });
}

function wikipediaHtmlToTextContent(html: string): string {
  const fragment = parseFragment(html);
  const stack: Array<{
    node: DefaultTreeAdapterMap["node"];
    phase: "enter" | "exit";
  }> = [];
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
      if (isElementNode(node) && WIKIPEDIA_BLOCK_TAGS.has(node.tagName.toLowerCase())) {
        chunks.push(" ");
      }
      continue;
    }

    if (isElementNode(node)) {
      const tagName = node.tagName.toLowerCase();
      const headingLevel = headingLevelFromTag(tagName);
      if (headingLevel !== null) {
        if (skipSectionLevel !== null && headingLevel <= skipSectionLevel) {
          skipSectionLevel = null;
        }

        const headingText = normalizeWikipediaSectionTitle(textContentOfNode(node));
        if (isExcludedWikipediaSectionTitle(headingText)) {
          skipSectionLevel = headingLevel;
          continue;
        }
      }

      if (skipSectionLevel !== null || shouldSkipWikipediaElement(node)) {
        continue;
      }

      if (WIKIPEDIA_BLOCK_TAGS.has(tagName)) {
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
  if (!isRecord(value)) return null;
  const parse = value["parse"];
  if (!isRecord(parse)) return null;

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

  const response = await fetch(endpoint);
  if (!response.ok) {
    return {
      success: false,
      failureReason: `Wikipedia parse API returned ${response.status}`,
    };
  }

  const data: unknown = await response.json();
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
