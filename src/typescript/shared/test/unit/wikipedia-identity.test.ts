import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeWikipediaTitleToken,
  parseWikipediaIdentity,
  wikipediaExternalIdFromPageId,
} from "../../src/wikipedia-identity.js";

test("normalizeWikipediaTitleToken normalizes spacing and underscores", () => {
  assert.equal(normalizeWikipediaTitleToken("  Alan__Turing  "), "Alan_Turing");
  assert.equal(normalizeWikipediaTitleToken("   "), null);
});

test("parseWikipediaIdentity prefers page ID identity when available", () => {
  const parsed = parseWikipediaIdentity("https://en.wikipedia.org/wiki/OpenAI?curid=48795986");
  assert.deepEqual(parsed, {
    language: "en",
    title: "OpenAI",
    pageId: "48795986",
    identityKind: "PAGE_ID",
    externalId: "en:48795986",
  });
});

test("parseWikipediaIdentity parses title identity from /w/index.php route", () => {
  const parsed = parseWikipediaIdentity(
    "https://en.wikipedia.org/w/index.php?title=OpenAI&oldid=1340968511",
  );
  assert.deepEqual(parsed, {
    language: "en",
    title: "OpenAI",
    pageId: null,
    identityKind: "TITLE",
    externalId: "en:OpenAI",
  });
});

test("parseWikipediaIdentity rejects non-article namespaces", () => {
  assert.equal(parseWikipediaIdentity("https://en.wikipedia.org/wiki/Talk:OpenAI"), null);
  assert.equal(parseWikipediaIdentity("https://en.wikipedia.org/wiki/File:Example.jpg"), null);
});

test("wikipediaExternalIdFromPageId builds deterministic external IDs", () => {
  assert.equal(wikipediaExternalIdFromPageId("en", "736"), "en:736");
});
