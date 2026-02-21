import type { Platform, PlatformContent } from "@openerrata/shared";
import { normalizeContent } from "@openerrata/shared";

export interface PlatformAdapter {
  platformKey: Platform;
  matches(url: string): boolean;
  detectFromDom?(document: Document): boolean;
  extract(document: Document): PlatformContent | null;
  getContentRoot(document: Document): Element | null;
}

const POST_URL_REGEX =
  /(?:www\.)?lesswrong\.com\/posts\/([A-Za-z0-9]+)(?:\/([^/?#]*))?(?:[/?#]|$)/i;

const CONTENT_SELECTOR = ".PostsPage-postContent";
const AUTHOR_LINK_SELECTOR = 'a[href*="/users/"]';
const TAG_SELECTOR = 'a[href*="/tag/"]';
const JSON_LD_SELECTOR = 'script[type="application/ld+json"]';

function parseAuthorSlug(href: string | null): string | null {
  if (!href) return null;
  const match = href.match(/\/users\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function parseIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
  return parsed.toISOString();
}

function findPublishedDateInJsonLd(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findPublishedDateInJsonLd(nested, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const publishedRaw = record["datePublished"];
  if (typeof publishedRaw === "string") {
    const iso = parseIsoDate(publishedRaw);
    if (iso) return iso;
  }

  const createdRaw = record["dateCreated"];
  if (typeof createdRaw === "string") {
    const iso = parseIsoDate(createdRaw);
    if (iso) return iso;
  }

  for (const nested of Object.values(record)) {
    const found = findPublishedDateInJsonLd(nested, depth + 1);
    if (found) return found;
  }

  return null;
}

function extractPublishedAt(document: Document): string | null {
  const metaDateSelectors = [
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
    'meta[property="og:article:published_time"]',
    'meta[name="date"]',
    'meta[name="pubdate"]',
  ];

  for (const selector of metaDateSelectors) {
    const value = document.querySelector(selector)?.getAttribute("content");
    const iso = parseIsoDate(value);
    if (iso) return iso;
  }

  const timeDateTime = document.querySelector("time[datetime]")?.getAttribute("datetime");
  const timeIso = parseIsoDate(timeDateTime);
  if (timeIso) return timeIso;

  const jsonLdScripts = Array.from(
    document.querySelectorAll<HTMLScriptElement>(JSON_LD_SELECTOR),
  );
  for (const script of jsonLdScripts) {
    const text = script.textContent.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      const publishedAt = findPublishedDateInJsonLd(parsed);
      if (publishedAt) return publishedAt;
    } catch {
      // Ignore malformed JSON-LD blobs.
    }
  }

  return null;
}

function extractImageUrls(root: Element): string[] {
  const uniqueUrls = new Set<string>();
  const images = Array.from(root.querySelectorAll<HTMLImageElement>("img[src]"));

  for (const image of images) {
    const src = image.getAttribute("src")?.trim() ?? "";
    if (src.length === 0) continue;
    if (src.startsWith("data:")) continue;

    try {
      const normalizedUrl = new URL(src, window.location.href).toString();
      uniqueUrls.add(normalizedUrl);
    } catch {
      // Ignore malformed image URLs in extracted content.
    }
  }

  return Array.from(uniqueUrls);
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

    const imageUrls = extractImageUrls(body);
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
