import { normalizeContent, hashContent, type Platform } from "@openerrata/shared";

type FetchResult =
  | {
      success: true;
      contentText: string;
      contentHash: string;
    }
  | {
      success: false;
      failureReason: string;
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

/** Standard HTML named character references (HTML5 §12.5). */
const NAMED_ENTITIES: Partial<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
  ndash: "\u2013",
  mdash: "\u2014",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  hellip: "\u2026",
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",
  bull: "\u2022",
  middot: "\u00B7",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  zwnj: "\u200C",
  zwj: "\u200D",
  lrm: "\u200E",
  rlm: "\u200F",
};

/**
 * Decode HTML character references (named + numeric) in a string.
 * Handles `&name;`, `&#NNN;`, and `&#xHHH;` forms.
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#x([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z]+));/g,
    (match, _full: string, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
      if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
      if (dec !== undefined) return String.fromCodePoint(parseInt(dec, 10));
      if (name !== undefined) {
        const resolved: string | undefined = NAMED_ENTITIES[name];
        return resolved ?? match;
      }
      return match;
    },
  );
}

/**
 * Extract text content from HTML, matching browser `textContent` behavior:
 * strip tags, decode character references, concatenate text nodes.
 */
function htmlToTextContent(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ""));
}

export async function fetchCanonicalContent(
  platform: Platform,
  _url: string,
  externalId: string,
): Promise<FetchResult> {
  try {
    switch (platform) {
      case "LESSWRONG":
        return await fetchLesswrongContent(externalId);
      case "X":
        return await fetchXContent();
      case "SUBSTACK":
        return await fetchSubstackContent();
    }
  } catch (error) {
    return {
      success: false,
      failureReason: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function fetchLesswrongContent(postId: string): Promise<FetchResult> {
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

  const data = await response.json();
  const html = extractLesswrongHtml(data);
  if (!html) {
    return {
      success: false,
      failureReason: "Could not extract HTML from LW API response",
    };
  }

  const contentText = normalizeContent(htmlToTextContent(html));
  const contentHash = await hashContent(contentText);
  return { success: true, contentText, contentHash };
}

async function fetchXContent(): Promise<FetchResult> {
  // X/Twitter server-side fetch is not implemented in v1.
  // X API requires authenticated access with rate limits.
  // All X investigations use CLIENT_FALLBACK provenance.
  return {
    success: false,
    failureReason: "X server-side fetch not implemented in v1",
  };
}

async function fetchSubstackContent(): Promise<FetchResult> {
  // Substack server-side fetch is not implemented in v1.
  // Investigations run from client-extracted content.
  return {
    success: false,
    failureReason: "Substack server-side fetch not implemented in v1",
  };
}
