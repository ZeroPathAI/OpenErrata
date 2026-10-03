/**
 * HTML-to-Markdown converter for LLM investigation prompts.
 *
 * Generates structured markdown with image placeholders from stored HTML so
 * the LLM can read headings, bullet lists, blockquotes, inline images, etc.
 * The flat text (normalizeContent) remains the canonical representation for
 * claim quoting and matching; markdown is the sole prompt content section.
 *
 * Uses Turndown for HTML→markdown conversion, with a parse5 pre-filter
 * step for Wikipedia to strip excluded sections (References, External links,
 * etc.) and element-level noise (citation superscripts, edit links) before
 * Turndown sees the HTML.
 *
 * Each call creates a fresh TurndownService instance to track per-conversion
 * image placeholder state.
 */

import { NON_CONTENT_TAGS } from "@openerrata/shared";
import TurndownService from "turndown";
import { preFilterWikipediaHtml } from "./wikipedia-content-filter.js";

interface HtmlToMarkdownResult {
  markdown: string;
  /** Absolute source URL of the image behind `[IMAGE:N]`, indexed by N. */
  imageSourceUrls: string[];
}

/**
 * Renderer version tag. Bumped whenever Turndown configuration, pre-processing,
 * or image placeholder format changes — ensures InvestigationInput snapshots
 * record which renderer produced the stored markdown.
 */
export const MARKDOWN_RENDERER_VERSION = "1.3.0";

/**
 * Resolve an `<img src>` against the post URL (Wikipedia HTML uses
 * protocol-relative URLs) into the absolute form image occurrences use.
 * Returns null for sources that can never be fetched (data:, relative junk,
 * embedded credentials).
 */
function resolveImageSourceUrl(src: string, baseUrl: string): string | null {
  if (src.length === 0) return null;
  let resolved: URL;
  try {
    resolved = new URL(src, baseUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  if (resolved.username.length > 0 || resolved.password.length > 0) return null;
  return resolved.toString();
}

// ── Turndown configuration ────────────────────────────────────────────────

const TURNDOWN_OPTIONS: TurndownService.Options = {
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  strongDelimiter: "**",
};

/**
 * Convert HTML to markdown with an `[IMAGE:N]` placeholder for each `<img>`
 * whose source is a fetchable URL; images without one are dropped.
 *
 * Returns the markdown and the source URL behind each placeholder so the
 * investigation input can match placeholders to downloaded images by URL.
 */
function htmlToMarkdownWithImages(html: string, baseUrl: string): HtmlToMarkdownResult {
  const imageSourceUrls: string[] = [];

  const service = new TurndownService(TURNDOWN_OPTIONS);

  service.addRule("imagePlaceholder", {
    filter: "img",
    replacement: (_content, node) => {
      const sourceUrl = resolveImageSourceUrl(node.getAttribute("src")?.trim() ?? "", baseUrl);
      if (sourceUrl === null) {
        return "";
      }
      const index = imageSourceUrls.length;
      imageSourceUrls.push(sourceUrl);
      return ` [IMAGE:${index.toString()}] `;
    },
  });

  // Strip the anchor wrapper when a link contains only image(s). Platforms like
  // Substack wrap images in <a href="..."><img/></a> to make them clickable.
  // Turndown's default link rule would produce "[ [IMAGE:0] ](url)" with extra
  // blank lines from inner block containers (div, figure, etc.). The anchor URL
  // is redundant — the image URL is already captured in imageSourceUrls for
  // matching — so we discard it and return just the placeholder(s).
  service.addRule("imageOnlyLink", {
    filter: (node) =>
      node.nodeName === "A" &&
      (node as Element).querySelector("img") !== null &&
      node.textContent.trim().length === 0,
    replacement: (content) => {
      const matches = content.match(/\[IMAGE:\d+\]/g);
      return matches !== null ? matches.join(" ") : content;
    },
  });

  // Render inline emphasis elements as plain text. The LLM needs structural
  // markdown (headings, lists) to understand document layout, but inline tokens
  // (bold, italic, strikethrough, inline code) contaminate verbatim claim
  // quotes: the LLM reads them and reproduces them, but claim text must anchor
  // against plain DOM text in the extension which has no markdown syntax.
  // Links are preserved — their URLs are useful investigative context.
  service.addRule("inlineEmphasisAsPlainText", {
    filter: ["strong", "b", "em", "i", "del", "s"],
    replacement: (content) => content,
  });

  service.addRule("inlineCodeAsPlainText", {
    filter: (node) => node.nodeName === "CODE" && node.parentNode?.nodeName !== "PRE",
    replacement: (content) => content,
  });

  service.remove((node) => NON_CONTENT_TAGS.has(node.nodeName.toLowerCase()));

  const markdown = service.turndown(html);
  return { markdown, imageSourceUrls };
}

// ── Platform wrappers ────────────────────────────────────────────────────
// `postUrl` is the base for resolving relative image sources.

export function lesswrongHtmlToContentMarkdown(
  html: string,
  postUrl: string,
): HtmlToMarkdownResult {
  return htmlToMarkdownWithImages(html, postUrl);
}

export function wikipediaHtmlToContentMarkdown(
  html: string,
  postUrl: string,
): HtmlToMarkdownResult {
  return htmlToMarkdownWithImages(preFilterWikipediaHtml(html), postUrl);
}

export function substackHtmlToContentMarkdown(html: string, postUrl: string): HtmlToMarkdownResult {
  return htmlToMarkdownWithImages(html, postUrl);
}
