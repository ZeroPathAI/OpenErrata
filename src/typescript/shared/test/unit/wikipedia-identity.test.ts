import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeWikipediaTitleToken,
  parseWikipediaUrlIdentity,
  wikipediaExternalIdFromPageId,
} from "../../src/wikipedia-identity.js";

test("normalizeWikipediaTitleToken normalizes spacing and underscores", () => {
  assert.equal(normalizeWikipediaTitleToken("  Alan__Turing  "), "Alan_Turing");
  assert.equal(normalizeWikipediaTitleToken("   "), null);
});

test("parseWikipediaUrlIdentity prefers page ID identity when available", () => {
  const parsed = parseWikipediaUrlIdentity("https://en.wikipedia.org/wiki/OpenAI?curid=48795986");
  assert.deepEqual(parsed, {
    kind: "PAGE_ID",
    language: "en",
    title: "OpenAI",
    pageId: "48795986",
  });
});

test("parseWikipediaUrlIdentity accepts page-ID-only index.php URLs", () => {
  const parsed = parseWikipediaUrlIdentity("https://de.wikipedia.org/w/index.php?curid=736");
  assert.deepEqual(parsed, { kind: "PAGE_ID", language: "de", title: null, pageId: "736" });
});

test("parseWikipediaUrlIdentity parses title identity from /w/index.php route", () => {
  const parsed = parseWikipediaUrlIdentity(
    "https://en.wikipedia.org/w/index.php?title=OpenAI&oldid=1340968511",
  );
  assert.deepEqual(parsed, { kind: "TITLE", language: "en", title: "OpenAI" });
});

test("parseWikipediaUrlIdentity rejects canonical non-article namespaces on any language edition", () => {
  assert.equal(parseWikipediaUrlIdentity("https://en.wikipedia.org/wiki/Talk:OpenAI"), null);
  assert.equal(parseWikipediaUrlIdentity("https://en.wikipedia.org/wiki/File:Example.jpg"), null);
  // MediaWiki accepts canonical namespace names on every wiki.
  assert.equal(parseWikipediaUrlIdentity("https://de.wikipedia.org/wiki/Talk:OpenAI"), null);
});

test("parseWikipediaUrlIdentity rejects non-Wikipedia hosts and namespace-less paths", () => {
  assert.equal(parseWikipediaUrlIdentity("https://example.org/wiki/OpenAI"), null);
  assert.equal(parseWikipediaUrlIdentity("https://en.wikipedia.org/"), null);
  assert.equal(parseWikipediaUrlIdentity("not a url"), null);
});

test("wikipediaExternalIdFromPageId builds deterministic external IDs", () => {
  assert.equal(wikipediaExternalIdFromPageId("en", "736"), "en:736");
});
