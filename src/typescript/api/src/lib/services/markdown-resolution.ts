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
import {
  lesswrongHtmlToContentMarkdown,
  substackHtmlToContentMarkdown,
  wikipediaHtmlToContentMarkdown,
  MARKDOWN_RENDERER_VERSION,
} from "./html-to-markdown.js";

/**
 * Source-scoped HTML snapshots with the serverVerifiedAt latch bundled in.
 *
 * The discriminated union encodes the DB invariant:
 *   serverVerifiedAt IS NOT NULL → serverHtmlBlobId IS NOT NULL
 * When server-verified, serverHtml is guaranteed non-null at the type level.
 */
export type HtmlSnapshots =
  | { serverVerifiedAt: Date; serverHtml: string; clientHtml: string | null }
  | { serverVerifiedAt: null; serverHtml: string | null; clientHtml: string | null };

type MarkdownResolution =
  | {
      source: "SERVER_HTML" | "CLIENT_HTML";
      markdown: string;
      rendererVersion: string;
      /** Source URL of the image behind `[IMAGE:N]`, indexed by N. */
      imageSourceUrls: string[];
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
 *
 * `postUrl` is the base for resolving relative image sources.
 */
export function resolveMarkdownForInvestigation(input: {
  platform: Platform;
  snapshots: HtmlSnapshots;
  postUrl: string;
}): MarkdownResolution {
  if (input.snapshots.serverVerifiedAt !== null) {
    return {
      source: "SERVER_HTML",
      rendererVersion: MARKDOWN_RENDERER_VERSION,
      ...platformMarkdown(input.platform, input.snapshots.serverHtml, input.postUrl),
    };
  }

  if (input.snapshots.clientHtml !== null) {
    return {
      source: "CLIENT_HTML",
      rendererVersion: MARKDOWN_RENDERER_VERSION,
      ...platformMarkdown(input.platform, input.snapshots.clientHtml, input.postUrl),
    };
  }

  return { source: "NONE" };
}

function platformMarkdown(
  platform: Platform,
  html: string,
  postUrl: string,
): { markdown: string; imageSourceUrls: string[] } {
  switch (platform) {
    case "LESSWRONG":
      return lesswrongHtmlToContentMarkdown(html, postUrl);
    case "SUBSTACK":
      return substackHtmlToContentMarkdown(html, postUrl);
    case "WIKIPEDIA":
      return wikipediaHtmlToContentMarkdown(html, postUrl);
    case "X":
      // X has no HTML; resolveMarkdownForInvestigation returns NONE before
      // reaching here. If this fires, the caller has a bug.
      throw new Error("platformMarkdown called for X, which has no HTML content");
  }
}
