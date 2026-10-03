import { httpUrlSchema, normalizeContent } from "@openerrata/shared";
import { decodeHTML } from "entities";
import { z } from "zod";
import { fetchPublicHttp, readBodyPrefix } from "$lib/network/public-http-fetch.js";

const MAX_FETCH_URL_BYTES = 1_000_000;
const MAX_FETCH_URL_TEXT_LENGTH = 20_000;
const FETCH_URL_TIMEOUT_MS = 15_000;

const fetchUrlToolArgumentsSchema = z.object({
  url: z.preprocess((value) => (typeof value === "string" ? value.trim() : value), httpUrlSchema),
});

interface FetchUrlToolSuccess {
  ok: true;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  title: string | null;
  contentText: string;
  truncated: boolean;
  retrievedAt: string;
}

interface FetchUrlToolParseFailure {
  ok: false;
  errorKind: "INVALID_ARGUMENTS";
  requestedUrl: null;
  error: string;
}

interface FetchUrlToolRequestFailure {
  ok: false;
  errorKind: "FETCH_FAILED";
  requestedUrl: string;
  error: string;
}

type FetchUrlToolFailure = FetchUrlToolParseFailure | FetchUrlToolRequestFailure;
type FetchUrlToolOutput = FetchUrlToolSuccess | FetchUrlToolFailure;

export const FETCH_URL_TOOL_NAME = "fetch_url";

export const fetchUrlToolDefinition = {
  type: "function" as const,
  name: FETCH_URL_TOOL_NAME,
  description:
    "Fetch a specific public URL and return normalized text content for citation validation.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "A fully qualified HTTP(S) URL to fetch.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

function extractTitleFromHtml(html: string): string | null {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!titleMatch) return null;
  const rawTitle = titleMatch[1];
  if (rawTitle === undefined) return null;
  const title = normalizeContent(decodeHTML(rawTitle));
  return title.length > 0 ? title : null;
}

function extractTextFromHtml(html: string): string {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const withoutStyles = withoutScripts.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withoutNoscript = withoutStyles.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const withoutComments = withoutNoscript.replace(/<!--[\s\S]*?-->/g, " ");
  const withoutTags = withoutComments.replace(/<[^>]+>/g, " ");
  return normalizeContent(decodeHTML(withoutTags));
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) {
    return { value, truncated: false };
  }

  return {
    value: encoded.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

function parseContentType(contentTypeHeader: string | null): string {
  if (contentTypeHeader === null) return "";
  return contentTypeHeader.split(";")[0]?.trim().toLowerCase() ?? "";
}

function extractContentText(
  contentType: string,
  rawBody: string,
): {
  contentText: string;
  title: string | null;
} {
  if (contentType.includes("html")) {
    return {
      contentText: extractTextFromHtml(rawBody),
      title: extractTitleFromHtml(rawBody),
    };
  }

  if (contentType.includes("json")) {
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      return {
        contentText: normalizeContent(JSON.stringify(parsed, null, 2)),
        title: null,
      };
    } catch {
      return {
        contentText: normalizeContent(rawBody),
        title: null,
      };
    }
  }

  return {
    contentText: normalizeContent(rawBody),
    title: null,
  };
}

/**
 * Run the `fetch_url` tool: GET a public URL chosen by the model and return
 * its normalized text. Untrusted URLs go through the SSRF-safe public fetcher;
 * bodies are read up to MAX_FETCH_URL_BYTES. Aborting `signal` (e.g. the run
 * lost its lease) aborts the request.
 */
export async function executeFetchUrlTool(
  rawArguments: string,
  signal: AbortSignal,
): Promise<FetchUrlToolOutput> {
  let parsedArguments: z.infer<typeof fetchUrlToolArgumentsSchema>;
  try {
    parsedArguments = fetchUrlToolArgumentsSchema.parse(JSON.parse(rawArguments));
  } catch (error) {
    return {
      ok: false,
      errorKind: "INVALID_ARGUMENTS",
      requestedUrl: null,
      error: `Invalid fetch_url arguments: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }

  const requestedUrl = parsedArguments.url;

  try {
    const { finalUrl, response } = await fetchPublicHttp({
      url: new URL(requestedUrl),
      headers: {
        "User-Agent": "OpenErrataInvestigator/1.0 (+https://openerrata.com)",
        Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5",
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_URL_TIMEOUT_MS)]),
    });

    const body = await readBodyPrefix(response, MAX_FETCH_URL_BYTES);
    const rawBody = new TextDecoder().decode(body.bytes);
    const normalizedContentType = parseContentType(response.headers.get("content-type"));
    const extracted = extractContentText(normalizedContentType, rawBody);
    const textTruncation = truncateUtf8(extracted.contentText, MAX_FETCH_URL_TEXT_LENGTH);

    return {
      ok: true,
      requestedUrl,
      finalUrl: finalUrl.toString(),
      status: response.status,
      contentType: normalizedContentType.length > 0 ? normalizedContentType : null,
      title: extracted.title,
      contentText: textTruncation.value,
      truncated: body.truncated || textTruncation.truncated,
      retrievedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return {
      ok: false,
      errorKind: "FETCH_FAILED",
      requestedUrl,
      error: error instanceof Error ? error.message : "Unknown fetch error",
    };
  }
}
