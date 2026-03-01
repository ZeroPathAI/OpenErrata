import {
  hashText,
  readJsonFile,
  sanitizeFixtureKey,
  writeJsonFile,
} from "../../../test-support/fixture-cache.js";

const FIXTURES_DIRECTORY = new URL("./fixtures/wikipedia/", import.meta.url);
const WIKIPEDIA_FETCH_TIMEOUT_MS = 15_000;
const WIKIPEDIA_NUMERIC_CONFIG_TOKEN = /^\d+$/;

export const E2E_WIKIPEDIA_FIXTURE_KEYS = {
  ALI_KHAMENEI_PAGE_HTML: "wikipedia-ali-khamenei-page-html-1",
  OPENAI_PAGE_HTML: "wikipedia-openai-page-html-1",
  ALBERT_EINSTEIN_PAGE_HTML: "wikipedia-albert-einstein-page-html-1",
  CLIMATE_CHANGE_PAGE_HTML: "wikipedia-climate-change-page-html-1",
} as const;

type E2eWikipediaFixtureKey =
  (typeof E2E_WIKIPEDIA_FIXTURE_KEYS)[keyof typeof E2E_WIKIPEDIA_FIXTURE_KEYS];

interface E2eWikipediaFixtureDefinition {
  fixtureKey: string;
  sourceUrl: string;
}

const E2E_WIKIPEDIA_FIXTURE_DEFINITIONS: Record<
  E2eWikipediaFixtureKey,
  E2eWikipediaFixtureDefinition
> = {
  [E2E_WIKIPEDIA_FIXTURE_KEYS.ALI_KHAMENEI_PAGE_HTML]: {
    fixtureKey: E2E_WIKIPEDIA_FIXTURE_KEYS.ALI_KHAMENEI_PAGE_HTML,
    sourceUrl: "https://en.wikipedia.org/wiki/Ali_Khamenei",
  },
  [E2E_WIKIPEDIA_FIXTURE_KEYS.OPENAI_PAGE_HTML]: {
    fixtureKey: E2E_WIKIPEDIA_FIXTURE_KEYS.OPENAI_PAGE_HTML,
    sourceUrl: "https://en.wikipedia.org/wiki/OpenAI",
  },
  [E2E_WIKIPEDIA_FIXTURE_KEYS.ALBERT_EINSTEIN_PAGE_HTML]: {
    fixtureKey: E2E_WIKIPEDIA_FIXTURE_KEYS.ALBERT_EINSTEIN_PAGE_HTML,
    sourceUrl: "https://en.wikipedia.org/wiki/Albert_Einstein",
  },
  [E2E_WIKIPEDIA_FIXTURE_KEYS.CLIMATE_CHANGE_PAGE_HTML]: {
    fixtureKey: E2E_WIKIPEDIA_FIXTURE_KEYS.CLIMATE_CHANGE_PAGE_HTML,
    sourceUrl: "https://en.wikipedia.org/wiki/Climate_change",
  },
};

export interface E2eWikipediaFixture {
  key: string;
  sourceUrl: string;
  language: string;
  pageId: string;
  revisionId: string;
  fetchedAt: string;
  htmlSha256: string;
  html: string;
  /**
   * The article body HTML returned by the Wikipedia Parse API
   * (`action=parse&prop=text&oldid=<revisionId>`). This is the server's
   * canonical source of truth for content — the same HTML that
   * `fetchWikipediaContent` in `content-fetcher.ts` processes.
   *
   * Stored alongside the full page HTML so parity tests can compare:
   *   - client: DOM extraction from the full page (after JS runs in a browser)
   *   - server: `wikipediaHtmlToNormalizedText(parseApiHtml)`
   */
  parseApiHtml: string;
  parseApiHtmlSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fixturePath(fixtureKey: string): URL {
  return new URL(`${sanitizeFixtureKey(fixtureKey)}.json`, FIXTURES_DIRECTORY);
}

function parseNumericConfigValue(html: string, key: string): string | null {
  const pattern = new RegExp(`"${key}"\\s*:\\s*(\\d+)`);
  const match = pattern.exec(html);
  const token = match?.[1];
  if (token === undefined || !WIKIPEDIA_NUMERIC_CONFIG_TOKEN.test(token)) {
    return null;
  }
  return token;
}

function parseLanguageFromWikipediaHost(url: string): string | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  const match = /^([a-z0-9-]+)(?:\.m)?\.wikipedia\.org$/i.exec(parsedUrl.hostname);
  return match?.[1]?.toLowerCase() ?? null;
}

function validateFixture(record: unknown): E2eWikipediaFixture {
  if (!isRecord(record)) {
    throw new Error("Malformed Wikipedia e2e fixture: expected object.");
  }

  const key = record["key"];
  const sourceUrl = record["sourceUrl"];
  const language = record["language"];
  const pageId = record["pageId"];
  const revisionId = record["revisionId"];
  const fetchedAt = record["fetchedAt"];
  const htmlSha256 = record["htmlSha256"];
  const html = record["html"];
  const parseApiHtml = record["parseApiHtml"];
  const parseApiHtmlSha256 = record["parseApiHtmlSha256"];

  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Malformed Wikipedia e2e fixture: missing key.");
  }
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) {
    throw new Error(`Malformed Wikipedia e2e fixture (${key}): missing sourceUrl.`);
  }
  if (typeof language !== "string" || language.length === 0) {
    throw new Error(`Malformed Wikipedia e2e fixture (${key}): missing language.`);
  }
  if (typeof pageId !== "string" || !WIKIPEDIA_NUMERIC_CONFIG_TOKEN.test(pageId)) {
    throw new Error(`Malformed Wikipedia e2e fixture (${key}): invalid pageId.`);
  }
  if (typeof revisionId !== "string" || !WIKIPEDIA_NUMERIC_CONFIG_TOKEN.test(revisionId)) {
    throw new Error(`Malformed Wikipedia e2e fixture (${key}): invalid revisionId.`);
  }
  if (typeof fetchedAt !== "string" || fetchedAt.length === 0) {
    throw new Error(`Malformed Wikipedia e2e fixture (${key}): missing fetchedAt.`);
  }
  if (typeof htmlSha256 !== "string" || htmlSha256.length === 0) {
    throw new Error(`Malformed Wikipedia e2e fixture (${key}): missing htmlSha256.`);
  }
  if (typeof html !== "string" || html.length === 0) {
    throw new Error(`Malformed Wikipedia e2e fixture (${key}): missing html.`);
  }
  if (hashText(html) !== htmlSha256) {
    throw new Error(`Wikipedia e2e fixture ${key} is corrupt: htmlSha256 does not match payload.`);
  }
  if (typeof parseApiHtml !== "string" || parseApiHtml.length === 0) {
    throw new Error(`Malformed Wikipedia e2e fixture (${key}): missing parseApiHtml.`);
  }
  if (typeof parseApiHtmlSha256 !== "string" || parseApiHtmlSha256.length === 0) {
    throw new Error(`Malformed Wikipedia e2e fixture (${key}): missing parseApiHtmlSha256.`);
  }
  if (hashText(parseApiHtml) !== parseApiHtmlSha256) {
    throw new Error(
      `Wikipedia e2e fixture ${key} is corrupt: parseApiHtmlSha256 does not match payload.`,
    );
  }

  return {
    key,
    sourceUrl,
    language,
    pageId,
    revisionId,
    fetchedAt,
    htmlSha256,
    html,
    parseApiHtml,
    parseApiHtmlSha256,
  };
}

export function resolveE2eWikipediaFixtureDefinition(
  fixtureKey: string,
): E2eWikipediaFixtureDefinition {
  if (!Object.hasOwn(E2E_WIKIPEDIA_FIXTURE_DEFINITIONS, fixtureKey)) {
    const knownKeys = Object.keys(E2E_WIKIPEDIA_FIXTURE_DEFINITIONS).join(", ");
    throw new Error(`Unknown Wikipedia e2e fixture key "${fixtureKey}". Known keys: ${knownKeys}.`);
  }

  return E2E_WIKIPEDIA_FIXTURE_DEFINITIONS[fixtureKey as E2eWikipediaFixtureKey];
}

export async function readE2eWikipediaFixture(fixtureKey: string): Promise<E2eWikipediaFixture> {
  const path = fixturePath(fixtureKey);
  const fixture = validateFixture(await readJsonFile(path));
  if (fixture.key !== fixtureKey) {
    throw new Error(
      `Fixture key mismatch: requested ${fixtureKey}, but file contains ${fixture.key}.`,
    );
  }
  return fixture;
}

export async function fetchWikipediaHtmlFromLive(sourceUrl: string): Promise<string> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort("Wikipedia live fetch timed out");
  }, WIKIPEDIA_FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(sourceUrl, {
      signal: abortController.signal,
      headers: {
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "OpenErrataFixtureRefresher/1.0 (+https://github.com/ZeroPathAI/openerrata)",
      },
    });
  } catch (error: unknown) {
    if (abortController.signal.aborted) {
      const reason = abortController.signal.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : `Wikipedia live fetch timed out after ${WIKIPEDIA_FETCH_TIMEOUT_MS.toString()} ms`;
      throw new Error(message, { cause: error });
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Wikipedia live fetch failed: ${String(error)}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }

  if (abortController.signal.aborted) {
    const reason = abortController.signal.reason;
    throw new Error(
      reason instanceof Error
        ? reason.message
        : `Wikipedia live fetch timed out after ${WIKIPEDIA_FETCH_TIMEOUT_MS.toString()} ms`,
    );
  }

  if (!response.ok) {
    throw new Error(`Wikipedia live fetch failed: ${response.status.toString()}`);
  }

  return await response.text();
}

async function fetchWikipediaParseApiHtml(language: string, revisionId: string): Promise<string> {
  const endpoint = new URL(`https://${language}.wikipedia.org/w/api.php`);
  endpoint.searchParams.set("action", "parse");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("formatversion", "2");
  endpoint.searchParams.set("prop", "text|revid");
  endpoint.searchParams.set("oldid", revisionId);

  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": "OpenErrataFixtureRefresher/1.0 (+https://github.com/ZeroPathAI/openerrata)",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Wikipedia Parse API returned HTTP ${response.status.toString()} for revisionId ${revisionId}`,
    );
  }

  const data: unknown = await response.json();
  if (!isRecord(data)) {
    throw new Error("Wikipedia Parse API returned unexpected JSON shape.");
  }

  const parse = data["parse"];
  if (!isRecord(parse)) {
    throw new Error("Wikipedia Parse API returned unexpected JSON shape.");
  }

  const text = parse["text"];
  const responseRevisionId = parse["revid"];

  if (typeof text !== "string" || text.length === 0) {
    throw new Error("Wikipedia Parse API response missing 'parse.text' field.");
  }
  if (String(responseRevisionId) !== revisionId) {
    throw new Error(
      `Wikipedia Parse API revision mismatch: expected ${revisionId}, got ${String(responseRevisionId)}`,
    );
  }

  return text;
}

export async function captureE2eWikipediaFixture(input: {
  fixtureKey: string;
  sourceUrl: string;
}): Promise<E2eWikipediaFixture> {
  const html = await fetchWikipediaHtmlFromLive(input.sourceUrl);
  const pageId = parseNumericConfigValue(html, "wgArticleId");
  const revisionId = parseNumericConfigValue(html, "wgRevisionId");
  const language = parseLanguageFromWikipediaHost(input.sourceUrl);
  if (language === null || pageId === null || revisionId === null) {
    throw new Error(
      `Could not extract required Wikipedia identity metadata from ${input.sourceUrl}.`,
    );
  }

  const parseApiHtml = await fetchWikipediaParseApiHtml(language, revisionId);

  const fixture: E2eWikipediaFixture = {
    key: input.fixtureKey,
    sourceUrl: input.sourceUrl,
    language,
    pageId,
    revisionId,
    fetchedAt: new Date().toISOString(),
    htmlSha256: hashText(html),
    html,
    parseApiHtml,
    parseApiHtmlSha256: hashText(parseApiHtml),
  };

  await writeJsonFile(fixturePath(input.fixtureKey), fixture);
  return fixture;
}
