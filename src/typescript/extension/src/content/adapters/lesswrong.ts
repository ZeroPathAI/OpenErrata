import type { Platform, PlatformContent } from "@openerrata/shared";
import { normalizeContent } from "@openerrata/shared";
import {
  extractImageUrlsFromRoot,
  readFirstMetaDateAsIso,
  readFirstTimeDateAsIso,
  readPublishedDateFromJsonLd,
} from "./utils";

export interface PlatformAdapter {
  platformKey: Platform;
  matches(url: string): boolean;
  detectFromDom?(document: Document): boolean;
  detectPrivateOrGated?(document: Document): boolean;
  extract(document: Document): PlatformContent | null;
  getContentRoot(document: Document): Element | null;
}

const POST_URL_REGEX =
  /(?:www\.)?lesswrong\.com\/posts\/([A-Za-z0-9]+)(?:\/([^/?#]*))?(?:[/?#]|$)/i;

const CONTENT_SELECTOR = ".PostsPage-postContent";
const AUTHOR_LINK_SELECTOR = 'a[href*="/users/"]';
const TAG_SELECTOR = 'a[href*="/tag/"]';
const META_DATE_SELECTORS = [
  'meta[property="article:published_time"]',
  'meta[name="article:published_time"]',
  'meta[property="og:article:published_time"]',
  'meta[name="date"]',
  'meta[name="pubdate"]',
] as const;
const JSON_LD_DATE_KEYS = new Set(["datePublished", "dateCreated"]);

function parseAuthorSlug(href: string | null): string | null {
  if (!href) return null;
  const match = href.match(/\/users\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function extractPublishedAt(document: Document): string | null {
  return (
    readFirstMetaDateAsIso(document, META_DATE_SELECTORS) ??
    readFirstTimeDateAsIso([document]) ??
    readPublishedDateFromJsonLd(document, JSON_LD_DATE_KEYS)
  );
}

export const lesswrongAdapter: PlatformAdapter = {
  platformKey: "LESSWRONG",

  matches(url: string): boolean {
    return POST_URL_REGEX.test(url);
  },

  extract(document: Document): PlatformContent | null {
    const body = document.querySelector(CONTENT_SELECTOR);
    if (!body) return null;

    const match = window.location.href.match(POST_URL_REGEX);
    if (!match) return null;
    const externalId = match[1];
    if (!externalId) return null;

    const rawText = body.textContent;
    const contentText = normalizeContent(rawText);
    const normalizedTitle =
      normalizeContent(document.querySelector("h1")?.textContent ?? "") ||
      normalizeContent(document.title);
    const title = normalizedTitle.length > 0 ? normalizedTitle : null;

    const authorLink = document.querySelector<HTMLAnchorElement>(AUTHOR_LINK_SELECTOR);
    const normalizedAuthorName = normalizeContent(authorLink?.textContent ?? "");
    const authorName = normalizedAuthorName.length > 0 ? normalizedAuthorName : null;
    const authorSlug = parseAuthorSlug(authorLink?.getAttribute("href") ?? null);

    const tags = Array.from(document.querySelectorAll(TAG_SELECTOR))
      .map((el) => normalizeContent(el.textContent))
      .filter(Boolean);
    const slugToken = match[2];
    const slug = (slugToken === undefined ? "" : normalizeContent(slugToken)) || externalId;
    const publishedAt = extractPublishedAt(document);

    const imageUrls = extractImageUrlsFromRoot(body, window.location.href);
    const hasVideoOnlyMedia = body.querySelector("video, iframe") !== null;
    const mediaState =
      imageUrls.length > 0
        ? "has_images"
        : hasVideoOnlyMedia
          ? "video_only"
          : "text_only";
    const metadata = {
      slug,
      htmlContent: body.innerHTML,
      authorSlug,
      tags,
      ...(title === null ? {} : { title }),
      ...(authorName === null ? {} : { authorName }),
      ...(publishedAt === null ? {} : { publishedAt }),
    };

    return {
      platform: "LESSWRONG",
      externalId,
      url: window.location.href,
      contentText,
      mediaState,
      imageUrls,
      metadata,
    };
  },

  getContentRoot(document: Document): Element | null {
    return document.querySelector(CONTENT_SELECTOR);
  },
};
