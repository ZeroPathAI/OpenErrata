/**
 * Markdown resolution for investigation inputs.
 *
 * Encapsulates the entire markdown trust policy: given a platform, HTML blob,
 * and the PostVersion's serverVerifiedAt latch, determines the markdown source
 * label and generates the markdown content.
 *
 * The source label records the trust tier of the HTML that produced the markdown:
 * - SERVER_HTML: HTML was fetched by the server (canonical source API)
 * - CLIENT_HTML: HTML was sent by the extension (browser DOM snapshot)
 * - NONE: no HTML available (X posts, or missing HTML for other platforms)
 */

import type { Platform } from "@openerrata/shared";
import type { ImagePlaceholder } from "$lib/investigators/interface.js";
import type { HtmlSnapshots } from "./prompt-context.js";
import {
  lesswrongHtmlToContentMarkdown,
  substackHtmlToContentMarkdown,
  wikipediaHtmlToContentMarkdown,
  MARKDOWN_RENDERER_VERSION,
} from "./html-to-markdown.js";

type MarkdownResolution =
  | {
      source: "SERVER_HTML";
      markdown: string;
      rendererVersion: string;
      imagePlaceholders: ImagePlaceholder[];
    }
  | {
      source: "CLIENT_HTML";
      markdown: string;
      rendererVersion: string;
      imagePlaceholders: ImagePlaceholder[];
    }
  | { source: "NONE" };

/**
 * Resolve the markdown content for an investigation from stored HTML.
 *
 * The HtmlSnapshots discriminated union encodes the serverVerifiedAt↔serverHtml
 * invariant enforced by the DB trigger, so no runtime null-check is needed here:
 * - serverVerifiedAt non-null branch → serverHtml: string guaranteed by type
 * - serverVerifiedAt null + clientHtml non-null → CLIENT_HTML
 * - otherwise → NONE (X posts, or versions without HTML snapshots)
 */
export function resolveMarkdownForInvestigation(input: {
  platform: Platform;
  snapshots: HtmlSnapshots;
}): MarkdownResolution {
  if (input.snapshots.serverVerifiedAt !== null) {
    const { markdown, imagePlaceholders } = platformMarkdown(
      input.platform,
      input.snapshots.serverHtml,
    );
    return {
      source: "SERVER_HTML",
      markdown,
      rendererVersion: MARKDOWN_RENDERER_VERSION,
      imagePlaceholders,
    };
  }

  if (input.snapshots.clientHtml !== null) {
    const { markdown, imagePlaceholders } = platformMarkdown(
      input.platform,
      input.snapshots.clientHtml,
    );
    return {
      source: "CLIENT_HTML",
      markdown,
      rendererVersion: MARKDOWN_RENDERER_VERSION,
      imagePlaceholders,
    };
  }

  return { source: "NONE" };
}

function platformMarkdown(
  platform: Platform,
  html: string,
): { markdown: string; imagePlaceholders: ImagePlaceholder[] } {
  switch (platform) {
    case "LESSWRONG":
      return lesswrongHtmlToContentMarkdown(html);
    case "SUBSTACK":
      return substackHtmlToContentMarkdown(html);
    case "WIKIPEDIA":
      return wikipediaHtmlToContentMarkdown(html);
    case "X":
      // X has no HTML; resolveMarkdownForInvestigation returns NONE before
      // reaching here. If this fires, the caller has a bug.
      throw new Error("platformMarkdown called for X, which has no HTML content");
  }
}

/**
 * Extract image placeholders from stored markdown by parsing `[IMAGE:N]` patterns.
 *
 * Used on retry to reconstruct placeholders from the InvestigationInput snapshot
 * without re-resolving from HTML.
 */
export function extractImagePlaceholdersFromMarkdown(markdown: string): ImagePlaceholder[] {
  const placeholders: ImagePlaceholder[] = [];
  const pattern = /\[IMAGE:(\d+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(markdown)) !== null) {
    placeholders.push({
      index: parseInt(match[1] ?? "0", 10),
      // sourceUrl is not recoverable from markdown alone; retries must match
      // placeholders to image occurrences by originalIndex.
      matchBy: "ORIGINAL_INDEX",
    });
  }

  return placeholders;
}
