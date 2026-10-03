/**
 * Live LessWrong canary: does production extraction still work against the
 * real LessWrong API?
 *
 * It runs the same canonical fetch registerObservedVersion uses and checks
 * properties that hold for any healthy extraction of the post, whatever its
 * author has since edited: the server verifies it, the text is substantial
 * and free of leaked markup, identity (URL, title, author) is extracted, and
 * normalization is stable across a re-fetch. It deliberately does not compare
 * against the cached fixture's text, which goes stale whenever the post is
 * edited (refresh it with `pnpm refresh:fixtures:lesswrong <key>`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INTEGRATION_LESSWRONG_FIXTURE_KEYS,
  readLesswrongFixture,
  resolveLesswrongFixtureDefinition,
} from "./lesswrong-fixtures.js";
import {
  fetchCanonicalContent,
  lesswrongHtmlToNormalizedText,
} from "../../src/lib/services/content-fetcher.js";

const fixtureKeysFromEnv = (process.env["LESSWRONG_CANARY_FIXTURE_KEYS"] ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const fixtureKeys =
  fixtureKeysFromEnv.length > 0
    ? fixtureKeysFromEnv
    : Object.values(INTEGRATION_LESSWRONG_FIXTURE_KEYS);

/**
 * Extracted text must keep at least this share of the cached fixture's text.
 * Edits move the length a little; extraction failures (truncated API fields,
 * a changed content field, an over-eager filter) lose most of it.
 */
const MIN_LIVE_TO_FIXTURE_TEXT_RATIO = 0.5;

// Structural HTML elements LessWrong posts are built from. Posts may quote
// angle-bracketed text (e.g. "<bash>") legitimately, so only real HTML element
// names count as leaked markup.
const LEAKED_TAG_PATTERN =
  /<\/?(?:p|div|span|a|em|strong|i|b|u|s|ul|ol|li|h[1-6]|blockquote|img|br|hr|figure|figcaption|table|thead|tbody|tr|td|th|code|pre|sup|sub|section|article)(?:\s[^<>]*)?\/?>/i;
const LEAKED_ENTITY_PATTERN = /&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/i;

async function fetchLive(externalId: string, url: string) {
  const result = await fetchCanonicalContent({ platform: "LESSWRONG", externalId, url });
  if (result.provenance !== "SERVER_VERIFIED") {
    assert.fail(
      `LessWrong canonical fetch fell back for ${externalId}: ${result.fetchFailureReason}`,
    );
  }
  return result;
}

void test(
  "live LessWrong extraction produces verified, clean, stable content and identity",
  { skip: fixtureKeys.length === 0 },
  async () => {
    for (const fixtureKey of fixtureKeys) {
      const definition = resolveLesswrongFixtureDefinition(fixtureKey);
      const fixture = await readLesswrongFixture(fixtureKey);
      const fixtureText = lesswrongHtmlToNormalizedText(fixture.html);

      const live = await fetchLive(definition.externalId, definition.postUrl);
      const label = `${fixtureKey} (${definition.externalId})`;

      assert.ok(
        live.contentText.length >= fixtureText.length * MIN_LIVE_TO_FIXTURE_TEXT_RATIO,
        `${label}: extracted ${live.contentText.length.toString()} chars, fixture has ${fixtureText.length.toString()}`,
      );
      assert.doesNotMatch(live.contentText, LEAKED_TAG_PATTERN, `${label}: HTML tags leaked`);
      assert.doesNotMatch(live.contentText, LEAKED_ENTITY_PATTERN, `${label}: entities leaked`);
      assert.equal(
        live.contentText,
        lesswrongHtmlToNormalizedText(live.sourceHtml),
        `${label}: stored text must be the normalization of the stored HTML`,
      );

      const identity = live.canonicalIdentity;
      if (identity.platform !== "LESSWRONG") {
        assert.fail(`${label}: canonical identity is for ${identity.platform}`);
      }
      assert.match(
        identity.url,
        new RegExp(`^https://www\\.lesswrong\\.com/posts/${definition.externalId}/[^/]+$`),
        `${label}: canonical URL`,
      );
      assert.ok(identity.title.trim().length > 0, `${label}: title extracted`);
      assert.doesNotMatch(identity.title, LEAKED_TAG_PATTERN, `${label}: title markup`);
      assert.deepEqual(identity.author, definition.author, `${label}: author`);

      const refetched = await fetchLive(definition.externalId, definition.postUrl);
      assert.equal(
        refetched.contentHash,
        live.contentHash,
        `${label}: normalized text changed between two consecutive fetches`,
      );
    }
  },
);
