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

  return {
    key,
    sourceUrl,
    language,
    pageId,
    revisionId,
    fetchedAt,
    htmlSha256,
    html,
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

  const fixture: E2eWikipediaFixture = {
    key: input.fixtureKey,
    sourceUrl: input.sourceUrl,
    language,
    pageId,
    revisionId,
    fetchedAt: new Date().toISOString(),
    htmlSha256: hashText(html),
    html,
  };

  await writeJsonFile(fixturePath(input.fixtureKey), fixture);
  return fixture;
}
