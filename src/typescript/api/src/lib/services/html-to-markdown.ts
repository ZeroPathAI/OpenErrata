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
import type { ImagePlaceholder } from "$lib/investigators/interface.js";
import { preFilterWikipediaHtml } from "./wikipedia-content-filter.js";

interface HtmlToMarkdownResult {
  markdown: string;
  imagePlaceholders: ImagePlaceholder[];
}

/**
 * Renderer version tag. Bumped whenever Turndown configuration, pre-processing,
 * or image placeholder format changes — ensures InvestigationInput snapshots
 * record which renderer produced the stored markdown.
 */
export const MARKDOWN_RENDERER_VERSION = "1.1.0";

// ── Turndown configuration ────────────────────────────────────────────────

const TURNDOWN_OPTIONS: TurndownService.Options = {
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  strongDelimiter: "**",
};

/**
 * Convert HTML to markdown with `[IMAGE:N]` placeholders for each `<img>` tag.
 *
 * Returns the markdown string and the ordered list of placeholders so the
 * input builder can match placeholders to resolved image occurrences by URL.
 */
function htmlToMarkdownWithImages(html: string): HtmlToMarkdownResult {
  const placeholders: ImagePlaceholder[] = [];

  const service = new TurndownService(TURNDOWN_OPTIONS);

  service.addRule("imagePlaceholder", {
    filter: "img",
    replacement: (_content, node) => {
      const src = node.getAttribute("src") ?? "";
      const index = placeholders.length;
      placeholders.push({ index, sourceUrl: src });
      return ` [IMAGE:${index}] `;
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
  return { markdown, imagePlaceholders: placeholders };
}

// ── Platform wrappers ────────────────────────────────────────────────────

export function lesswrongHtmlToContentMarkdown(html: string): HtmlToMarkdownResult {
  return htmlToMarkdownWithImages(html);
}

export function wikipediaHtmlToContentMarkdown(html: string): HtmlToMarkdownResult {
  return htmlToMarkdownWithImages(preFilterWikipediaHtml(html));
}

export function substackHtmlToContentMarkdown(html: string): HtmlToMarkdownResult {
  return htmlToMarkdownWithImages(html);
}
