import {
  hashText as hashFixtureText,
  readJsonFile,
  sanitizeFixtureKey,
  writeJsonFile,
} from "../../../test-support/fixture-cache.js";

export const hashText = hashFixtureText;

const FIXTURES_DIRECTORY = new URL("./fixtures/lesswrong/", import.meta.url);
const LESSWRONG_GRAPHQL_URL = "https://www.lesswrong.com/graphql";
const LESSWRONG_FETCH_TIMEOUT_MS = 10_000;
const LESSWRONG_GRAPHQL_QUERY = `query GetPost($id: String!) {
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
}`;

export const INTEGRATION_LESSWRONG_FIXTURE_KEYS = {
  POST_VIEW_HTML: "view-post-lesswrong-observed-html-1",
} as const;

type IntegrationLesswrongFixtureKey =
  (typeof INTEGRATION_LESSWRONG_FIXTURE_KEYS)[keyof typeof INTEGRATION_LESSWRONG_FIXTURE_KEYS];

interface LesswrongFixtureDefinition {
  fixtureKey: string;
  externalId: string;
  postUrl: string;
}

const INTEGRATION_LESSWRONG_FIXTURE_DEFINITIONS: Record<
  IntegrationLesswrongFixtureKey,
  LesswrongFixtureDefinition
> = {
  [INTEGRATION_LESSWRONG_FIXTURE_KEYS.POST_VIEW_HTML]: {
    fixtureKey: INTEGRATION_LESSWRONG_FIXTURE_KEYS.POST_VIEW_HTML,
    externalId: "ioZxrP7BhS5ArK59w",
    postUrl:
      "https://www.lesswrong.com/posts/ioZxrP7BhS5ArK59w/did-claude-3-opus-align-itself-via-gradient-hacking",
  },
};

export interface LesswrongFixture {
  key: string;
  externalId: string;
  postUrl: string;
  graphqlUrl: string;
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

function validateLesswrongFixture(record: unknown): LesswrongFixture {
  if (!isRecord(record)) {
    throw new Error("Malformed LessWrong fixture: expected object.");
  }

  const key = record["key"];
  const externalId = record["externalId"];
  const postUrl = record["postUrl"];
  const graphqlUrl = record["graphqlUrl"];
  const fetchedAt = record["fetchedAt"];
  const htmlSha256 = record["htmlSha256"];
  const html = record["html"];

  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Malformed LessWrong fixture: missing key.");
  }
  if (typeof externalId !== "string" || externalId.length === 0) {
    throw new Error(`Malformed LessWrong fixture (${key}): missing externalId.`);
  }
  if (typeof postUrl !== "string" || postUrl.length === 0) {
    throw new Error(`Malformed LessWrong fixture (${key}): missing postUrl.`);
  }
  if (typeof graphqlUrl !== "string" || graphqlUrl.length === 0) {
    throw new Error(`Malformed LessWrong fixture (${key}): missing graphqlUrl.`);
  }
  if (typeof fetchedAt !== "string" || fetchedAt.length === 0) {
    throw new Error(`Malformed LessWrong fixture (${key}): missing fetchedAt.`);
  }
  if (typeof htmlSha256 !== "string" || htmlSha256.length === 0) {
    throw new Error(`Malformed LessWrong fixture (${key}): missing htmlSha256.`);
  }
  if (typeof html !== "string") {
    throw new Error(`Malformed LessWrong fixture (${key}): missing html.`);
  }

  if (hashText(html) !== htmlSha256) {
    throw new Error(`LessWrong fixture ${key} is corrupt: htmlSha256 does not match payload.`);
  }

  return {
    key,
    externalId,
    postUrl,
    graphqlUrl,
    fetchedAt,
    htmlSha256,
    html,
  };
}

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

export async function readLesswrongFixture(fixtureKey: string): Promise<LesswrongFixture> {
  const path = fixturePath(fixtureKey);
  const record = validateLesswrongFixture(await readJsonFile(path));
  if (record.key !== fixtureKey) {
    throw new Error(
      `Fixture key mismatch: requested ${fixtureKey}, but file contains ${record.key}.`,
    );
  }
  return record;
}

export function resolveLesswrongFixtureDefinition(fixtureKey: string): LesswrongFixtureDefinition {
  if (!Object.hasOwn(INTEGRATION_LESSWRONG_FIXTURE_DEFINITIONS, fixtureKey)) {
    const knownFixtureKeys = Object.keys(INTEGRATION_LESSWRONG_FIXTURE_DEFINITIONS).join(", ");
    throw new Error(
      `Unknown LessWrong fixture key "${fixtureKey}". Known keys: ${knownFixtureKeys}.`,
    );
  }

  return INTEGRATION_LESSWRONG_FIXTURE_DEFINITIONS[fixtureKey as IntegrationLesswrongFixtureKey];
}

async function writeLesswrongFixture(fixture: LesswrongFixture): Promise<void> {
  const path = fixturePath(fixture.key);
  await writeJsonFile(path, fixture);
}

export async function fetchLesswrongHtmlFromLive(externalId: string): Promise<string> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort("LessWrong live fetch timed out");
  }, LESSWRONG_FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(LESSWRONG_GRAPHQL_URL, {
      signal: abortController.signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: LESSWRONG_GRAPHQL_QUERY,
        variables: { id: externalId },
      }),
    });
  } catch (error: unknown) {
    if (abortController.signal.aborted) {
      const reason: unknown = abortController.signal.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : `LessWrong live fetch timed out after ${LESSWRONG_FETCH_TIMEOUT_MS.toString()} ms`;
      throw new Error(message, { cause: error });
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`LessWrong live fetch failed: ${String(error)}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }

  if (abortController.signal.aborted) {
    const reason: unknown = abortController.signal.reason;
    throw new Error(
      reason instanceof Error
        ? reason.message
        : `LessWrong live fetch timed out after ${LESSWRONG_FETCH_TIMEOUT_MS.toString()} ms`,
    );
  }

  if (!response.ok) {
    throw new Error(`LessWrong live fetch failed: ${response.status}`);
  }

  const payload: unknown = await response.json();
  const html = extractLesswrongHtml(payload);
  if (html === null || html.length === 0) {
    throw new Error(`Could not extract html for LessWrong post ${externalId}.`);
  }
  return html;
}

export async function captureLesswrongFixture(input: {
  fixtureKey: string;
  externalId: string;
  postUrl: string;
}): Promise<LesswrongFixture> {
  const html = await fetchLesswrongHtmlFromLive(input.externalId);
  const fixture: LesswrongFixture = {
    key: input.fixtureKey,
    externalId: input.externalId,
    postUrl: input.postUrl,
    graphqlUrl: LESSWRONG_GRAPHQL_URL,
    fetchedAt: new Date().toISOString(),
    htmlSha256: hashText(html),
    html,
  };
  await writeLesswrongFixture(fixture);
  return fixture;
}
