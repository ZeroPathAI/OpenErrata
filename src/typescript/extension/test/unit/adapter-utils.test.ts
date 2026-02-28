import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  extractContentWithImageOccurrencesFromRoot,
  extractImageUrlsFromRoot,
  readFirstMetaDateAsIso,
  readFirstTimeDateAsIso,
  readPublishedDateFromJsonLd,
} from "../../src/content/adapters/utils";

function makeMetaElement(content: string | null): Element {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial DOM stub for unit testing
  return {
    getAttribute(name: string) {
      return name === "content" ? content : null;
    },
  } as unknown as Element;
}

function makeTimeElement(datetime: string | null): Element {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial DOM stub for unit testing
  return {
    getAttribute(name: string) {
      return name === "datetime" ? datetime : null;
    },
  } as unknown as Element;
}

function makeDocumentStub(input: {
  metaBySelector?: Record<string, string | null>;
  scripts?: string[];
  timeDateTime?: string | null;
}): Document {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial DOM stub for unit testing
  return {
    querySelector(selector: string) {
      if (selector === "time[datetime]") {
        if (input.timeDateTime === undefined) return null;
        return makeTimeElement(input.timeDateTime);
      }
      const content = input.metaBySelector?.[selector];
      return content === undefined ? null : makeMetaElement(content);
    },
    querySelectorAll(selector: string) {
      if (selector === 'script[type="application/ld+json"]') {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial DOM stub for unit testing
        return (input.scripts ?? []).map((text) => ({
          textContent: text,
        })) as unknown as NodeListOf<HTMLScriptElement>;
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial DOM stub for unit testing
      return [] as unknown as NodeListOf<Element>;
    },
  } as unknown as Document;
}

function makeTimeRoot(datetime: string | null | undefined): ParentNode {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial DOM stub for unit testing
  return {
    querySelector(selector: string) {
      if (selector !== "time[datetime]" || datetime === undefined) return null;
      return makeTimeElement(datetime);
    },
  } as unknown as ParentNode;
}

function makeImageRoot(
  srcValues: (string | null | undefined)[],
  expectedSelector = "img[src]",
): ParentNode {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial DOM stub for unit testing
  return {
    querySelectorAll(selector: string) {
      assert.equal(selector, expectedSelector);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial DOM stub for unit testing
      return srcValues.map((src) => ({
        getAttribute(name: string) {
          return name === "src" ? (src ?? null) : null;
        },
      })) as unknown as NodeListOf<HTMLImageElement>;
    },
  } as unknown as ParentNode;
}

test("readPublishedDateFromJsonLd respects candidate-key priority", () => {
  const document = makeDocumentStub({
    scripts: [
      JSON.stringify({
        dateCreated: "2024-01-02T00:00:00.000Z",
        datePublished: "2025-03-04T05:06:07.000Z",
      }),
    ],
  });

  const publishedAt = readPublishedDateFromJsonLd(
    document,
    new Set(["datePublished", "dateCreated"]),
  );

  assert.equal(publishedAt, "2025-03-04T05:06:07.000Z");
});

test("readPublishedDateFromJsonLd handles malformed and nested JSON-LD", () => {
  const document = makeDocumentStub({
    scripts: [
      "{invalid-json",
      JSON.stringify({
        "@graph": [
          {
            nested: {
              datePublished: "2025-08-09T10:11:12.000Z",
            },
          },
        ],
      }),
    ],
  });

  const publishedAt = readPublishedDateFromJsonLd(document, new Set(["datePublished"]));

  assert.equal(publishedAt, "2025-08-09T10:11:12.000Z");
});

test("readFirstMetaDateAsIso returns first valid selector in order", () => {
  const document = makeDocumentStub({
    metaBySelector: {
      'meta[property="article:published_time"]': "not-a-date",
      'meta[name="article:published_time"]': "2025-02-03T04:05:06.000Z",
    },
  });

  const publishedAt = readFirstMetaDateAsIso(document, [
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
  ]);

  assert.equal(publishedAt, "2025-02-03T04:05:06.000Z");
});

test("readFirstTimeDateAsIso scans roots in order and skips invalid timestamps", () => {
  const publishedAt = readFirstTimeDateAsIso([
    makeTimeRoot("invalid"),
    makeTimeRoot("2025-09-10T11:12:13.000Z"),
  ]);

  assert.equal(publishedAt, "2025-09-10T11:12:13.000Z");
});

test("extractImageUrlsFromRoot normalizes, deduplicates, and filters invalid sources", () => {
  const root = makeImageRoot([
    "/images/a.png",
    "https://cdn.example.com/a.jpg",
    " data:image/png;base64,abc123 ",
    "/images/a.png",
    "http://[::1",
    "",
    null,
  ]);

  const imageUrls = extractImageUrlsFromRoot(root, "https://example.com/posts/123");

  assert.deepEqual(imageUrls, [
    "https://example.com/images/a.png",
    "https://cdn.example.com/a.jpg",
  ]);
});

test("extractContentWithImageOccurrencesFromRoot keeps duplicate occurrences but unique imageUrls", () => {
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="root">AA<img src="/one.png" />BB<img src="/one.png" />CC</div></body></html>`,
    { url: "https://example.com/post/1" },
  );
  const root = dom.window.document.querySelector("#root");
  assert.ok(root);

  const extracted = extractContentWithImageOccurrencesFromRoot(root, "https://example.com/post/1");

  assert.equal(extracted.contentText, "AABBCC");
  assert.deepEqual(extracted.imageUrls, ["https://example.com/one.png"]);
  assert.deepEqual(extracted.imageOccurrences, [
    {
      originalIndex: 0,
      normalizedTextOffset: 2,
      sourceUrl: "https://example.com/one.png",
    },
    {
      originalIndex: 1,
      normalizedTextOffset: 4,
      sourceUrl: "https://example.com/one.png",
    },
  ]);
});

test("extractContentWithImageOccurrencesFromRoot caption precedence is figcaption > alt > title", () => {
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="root">A<img src="/a.png" alt="alt-a" title="title-a" /><figure><img src="/b.png" alt="alt-b" title="title-b" /><figcaption>  fig-b  </figcaption></figure><img src="/c.png" title="title-c" />Z</div></body></html>`,
    { url: "https://example.com/post/1" },
  );
  const root = dom.window.document.querySelector("#root");
  assert.ok(root);

  const extracted = extractContentWithImageOccurrencesFromRoot(root, "https://example.com/post/1");

  assert.deepEqual(
    extracted.imageOccurrences.map((occurrence) => occurrence.captionText),
    ["alt-a", "fig-b", "title-c"],
  );
});
