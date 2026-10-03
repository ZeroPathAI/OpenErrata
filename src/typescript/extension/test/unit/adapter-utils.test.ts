import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detachedImageOccurrences,
  extractContent,
  readFirstMetaDateAsIso,
  readFirstTimeDateAsIso,
  readPublishedDateFromJsonLd,
  serializeContentHtml,
  toTransportableHtml,
} from "../../src/content/adapters/utils";
import { requireElement, withDom } from "../helpers/dom";

function makeMetaElement(content: string | null): Element {
  return {
    getAttribute(name: string) {
      return name === "content" ? content : null;
    },
  } as unknown as Element;
}

function makeTimeElement(datetime: string | null): Element {
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
        return (input.scripts ?? []).map((text) => ({
          textContent: text,
        })) as unknown as NodeListOf<HTMLScriptElement>;
      }

      return [] as unknown as NodeListOf<Element>;
    },
  } as unknown as Document;
}

function makeTimeRoot(datetime: string | null | undefined): ParentNode {
  return {
    querySelector(selector: string) {
      if (selector !== "time[datetime]" || datetime === undefined) return null;
      return makeTimeElement(datetime);
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

const POST_URL = "https://example.com/post/1";
const noExclusions = { exclude: () => false, imageSelector: "img[src]", baseUrl: POST_URL };

test("extractContent keeps every image occurrence at its text offset, skipping unusable sources", () => {
  withDom(
    '<div id="root">AA<img src="/one.png" />BB<img src="/one.png" /><img src=" data:image/png;base64,abc " />CC</div>',
    (document) => {
      const extracted = extractContent(requireElement(document, "#root"), noExclusions);
      assert.equal(extracted.contentText, "AABBCC");
      assert.deepEqual(extracted.imageOccurrences, [
        { originalIndex: 0, normalizedTextOffset: 2, sourceUrl: "https://example.com/one.png" },
        { originalIndex: 1, normalizedTextOffset: 4, sourceUrl: "https://example.com/one.png" },
      ]);
    },
    POST_URL,
  );
});

test("extractContent caption precedence is figcaption > alt > title", () => {
  withDom(
    '<div id="root">A<img src="/a.png" alt="alt-a" title="title-a" /><figure><img src="/b.png" alt="alt-b" title="title-b" /><figcaption>  fig-b  </figcaption></figure><img src="/c.png" title="title-c" />Z</div>',
    (document) => {
      const extracted = extractContent(requireElement(document, "#root"), noExclusions);
      assert.deepEqual(
        extracted.imageOccurrences.map((occurrence) => occurrence.captionText),
        ["alt-a", "fig-b", "title-c"],
      );
    },
    POST_URL,
  );
});

test("extractContent leaves script and style text out, like the API's canonical text", () => {
  withDom(
    '<div id="root"><p>Kept.</p><script>window.tracking = 1;</script><style>.x{}</style><noscript>Enable JS</noscript></div>',
    (document) => {
      assert.equal(
        extractContent(requireElement(document, "#root"), noExclusions).contentText,
        "Kept.",
      );
    },
  );
});

test("serializeContentHtml strips highlight marks and excluded subtrees from the snapshot only", () => {
  withDom(
    '<div id="root"><p>The <mark class="openerrata-annotation" data-openerrata-claim-id="c1">moon is cheese</mark>.</p><div class="callout">Linkpost</div><script>x()</script></div>',
    (document) => {
      const root = requireElement(document, "#root");
      const html = serializeContentHtml(
        root,
        () => (element) => element.classList.contains("callout"),
      );
      assert.equal(html, "<p>The moon is cheese.</p>");
      // The live page keeps its highlight.
      assert.equal(root.querySelectorAll("mark").length, 1);
    },
  );
});

test("detachedImageOccurrences places images outside the text root at a fixed offset", () => {
  withDom(
    '<article><div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/a.jpg" alt="Photo" /></div><img src="https://pbs.twimg.com/profile_images/me.jpg" /></article>',
    (document) => {
      assert.deepEqual(
        detachedImageOccurrences(requireElement(document, "article"), {
          imageSelector: '[data-testid="tweetPhoto"] img',
          baseUrl: "https://x.com",
          normalizedTextOffset: 12,
        }),
        [
          {
            originalIndex: 0,
            normalizedTextOffset: 12,
            sourceUrl: "https://pbs.twimg.com/media/a.jpg",
            captionText: "Photo",
          },
        ],
      );
    },
  );
});

test("toTransportableHtml omits empty and oversized snapshots", () => {
  assert.equal(toTransportableHtml("", 10), undefined);
  assert.equal(toTransportableHtml("<p>ok</p>", 10), "<p>ok</p>");
  assert.equal(toTransportableHtml("<p>too long</p>", 10), undefined);
});
