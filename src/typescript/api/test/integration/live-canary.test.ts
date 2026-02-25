import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchLesswrongHtmlFromLive,
  hashText,
  INTEGRATION_LESSWRONG_FIXTURE_KEYS,
  readLesswrongFixture,
} from "./lesswrong-fixtures.js";
import { lesswrongHtmlToNormalizedText } from "../../src/lib/services/content-fetcher.js";

const fixtureKeysFromEnv = (process.env["LESSWRONG_CANARY_FIXTURE_KEYS"] ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const fixtureKeys =
  fixtureKeysFromEnv.length > 0
    ? fixtureKeysFromEnv
    : Object.values(INTEGRATION_LESSWRONG_FIXTURE_KEYS);

void test(
  "lesswrong fixture cache matches live pages",
  { skip: fixtureKeys.length === 0 },
  async () => {
    for (const fixtureKey of fixtureKeys) {
      const fixture = await readLesswrongFixture(fixtureKey);
      const liveHtml = await fetchLesswrongHtmlFromLive(fixture.externalId);
      const liveHash = hashText(lesswrongHtmlToNormalizedText(liveHtml));
      const fixtureHash = hashText(lesswrongHtmlToNormalizedText(fixture.html));

      assert.equal(
        liveHash,
        fixtureHash,
        `Live LessWrong fixture drift detected for ${fixtureKey} (${fixture.externalId}).`,
      );
    }
  },
);
