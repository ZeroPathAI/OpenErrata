import { normalizeContent } from "@openerrata/shared";
import { decodeHTML } from "entities";
import { z } from "zod";
import { isBlockedHost } from "$lib/network/host-safety.js";
import { isRedirectStatus } from "$lib/network/http-status.js";

const MAX_FETCH_URL_BYTES = 1_000_000;
const MAX_FETCH_URL_TEXT_LENGTH = 20_000;
const FETCH_URL_TIMEOUT_MS = 15_000;
const MAX_REDIRECT_HOPS = 5;

const fetchUrlToolArgumentsSchema = z.object({
  url: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z
      .url("url must be a valid URL")
      .refine((value) => /^https?:\/\//i.test(value), "url must use http:// or https://"),
  ),
});

type FetchUrlToolSuccess = {
  ok: true;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  title: string | null;
  contentText: string;
  truncated: boolean;
  retrievedAt: string;
};

type FetchUrlToolParseFailure = {
  ok: false;
  errorKind: "INVALID_ARGUMENTS";
  requestedUrl: null;
  error: string;
};

type FetchUrlToolRequestFailure = {
  ok: false;
  errorKind: "FETCH_FAILED";
  requestedUrl: string;
  error: string;
};

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

function hasEmbeddedCredentials(url: URL): boolean {
  return url.username.length > 0 || url.password.length > 0;
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

export async function executeFetchUrlTool(rawArguments: string): Promise<FetchUrlToolOutput> {
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

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(requestedUrl);
  } catch {
    return {
      ok: false,
      errorKind: "FETCH_FAILED",
      requestedUrl,
      error: "Invalid URL",
    };
  }

  if (hasEmbeddedCredentials(parsedUrl)) {
    return {
      ok: false,
      errorKind: "FETCH_FAILED",
      requestedUrl,
      error: "URLs with embedded credentials are not allowed",
    };
  }

  try {
    let currentUrl = parsedUrl;
    let response: Response | null = null;

    for (let redirectHop = 0; redirectHop <= MAX_REDIRECT_HOPS; redirectHop += 1) {
      if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") {
        return {
          ok: false,
          errorKind: "FETCH_FAILED",
          requestedUrl,
          error: "Only HTTP(S) URLs are allowed",
        };
      }

      const blockedHost = await isBlockedHost(currentUrl.hostname);
      if (blockedHost) {
        return {
          ok: false,
          errorKind: "FETCH_FAILED",
          requestedUrl,
          error: "Blocked host",
        };
      }

      const currentResponse = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
        headers: {
          "User-Agent": "OpenErrataInvestigator/1.0 (+https://openerrata.com)",
          Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5",
        },
      });

      if (isRedirectStatus(currentResponse.status)) {
        const location = currentResponse.headers.get("location");
        if (location === null || location.length === 0) {
          return {
            ok: false,
            errorKind: "FETCH_FAILED",
            requestedUrl,
            error: "Redirect response missing Location header",
          };
        }

        const redirectedUrl = new URL(location, currentUrl);
        if (hasEmbeddedCredentials(redirectedUrl)) {
          return {
            ok: false,
            errorKind: "FETCH_FAILED",
            requestedUrl,
            error: "Redirected URL contains embedded credentials",
          };
        }
        currentUrl = redirectedUrl;
        continue;
      }

      // Re-validate after request to reduce DNS-rebinding exposure windows.
      const becameBlocked = await isBlockedHost(currentUrl.hostname);
      if (becameBlocked) {
        return {
          ok: false,
          errorKind: "FETCH_FAILED",
          requestedUrl,
          error: "Blocked host",
        };
      }

      response = currentResponse;
      break;
    }

    if (!response) {
      return {
        ok: false,
        errorKind: "FETCH_FAILED",
        requestedUrl,
        error: "Too many redirects",
      };
    }

    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader !== null && contentLengthHeader.length > 0) {
      const contentLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_FETCH_URL_BYTES) {
        return {
          ok: false,
          errorKind: "FETCH_FAILED",
          requestedUrl,
          error: `Response too large (${contentLength.toString()} bytes)`,
        };
      }
    }

    const rawBody = await response.text();
    const byteTruncation = truncateUtf8(rawBody, MAX_FETCH_URL_BYTES);
    const normalizedContentType = parseContentType(response.headers.get("content-type"));
    const extracted = extractContentText(normalizedContentType, byteTruncation.value);
    const textTruncation = truncateUtf8(extracted.contentText, MAX_FETCH_URL_TEXT_LENGTH);

    return {
      ok: true,
      requestedUrl,
      finalUrl: currentUrl.toString(),
      status: response.status,
      contentType: normalizedContentType.length > 0 ? normalizedContentType : null,
      title: extracted.title,
      contentText: textTruncation.value,
      truncated: byteTruncation.truncated || textTruncation.truncated,
      retrievedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      errorKind: "FETCH_FAILED",
      requestedUrl,
      error: error instanceof Error ? error.message : "Unknown fetch error",
    };
  }
}
