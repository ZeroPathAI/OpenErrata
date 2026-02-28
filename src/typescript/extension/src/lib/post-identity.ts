import type { Platform } from "@openerrata/shared";
import { parseWikipediaIdentity } from "./wikipedia-url.js";

const LESSWRONG_EXTERNAL_ID_RE =
  /(?:www\.)?lesswrong\.com\/posts\/([A-Za-z0-9]+)(?:\/[^/?#]*)?(?:[/?#]|$)/i;
const X_HANDLE_STATUS_RE = /(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/i;
const X_WEB_STATUS_RE = /(?:x\.com|twitter\.com)\/i\/web\/status\/(\d+)/i;
const X_I_STATUS_RE = /(?:x\.com|twitter\.com)\/i\/status\/(\d+)/i;
const SUBSTACK_POST_RE = /(?:[a-z0-9-]+\.)substack\.com\/p\/([^/?#]+)(?:[/?#]|$)/i;

export interface SupportedPageIdentity {
  platform: Platform;
  externalId: string;
}

export function parseSupportedPageIdentity(url: string): SupportedPageIdentity | null {
  const lesswrongMatch = LESSWRONG_EXTERNAL_ID_RE.exec(url);
  const lesswrongExternalId = lesswrongMatch?.[1];
  if (lesswrongExternalId !== undefined && lesswrongExternalId.length > 0) {
    return {
      platform: "LESSWRONG",
      externalId: lesswrongExternalId,
    };
  }

  const xHandleMatch = X_HANDLE_STATUS_RE.exec(url);
  const xHandleExternalId = xHandleMatch?.[1];
  if (xHandleExternalId !== undefined && xHandleExternalId.length > 0) {
    return {
      platform: "X",
      externalId: xHandleExternalId,
    };
  }

  const xWebMatch = X_WEB_STATUS_RE.exec(url);
  const xWebExternalId = xWebMatch?.[1];
  if (xWebExternalId !== undefined && xWebExternalId.length > 0) {
    return {
      platform: "X",
      externalId: xWebExternalId,
    };
  }

  const xIStatusMatch = X_I_STATUS_RE.exec(url);
  const xIStatusExternalId = xIStatusMatch?.[1];
  if (xIStatusExternalId !== undefined && xIStatusExternalId.length > 0) {
    return {
      platform: "X",
      externalId: xIStatusExternalId,
    };
  }

  const substackMatch = SUBSTACK_POST_RE.exec(url);
  const substackExternalId = substackMatch?.[1];
  if (substackExternalId !== undefined && substackExternalId.length > 0) {
    return {
      platform: "SUBSTACK",
      externalId: substackExternalId,
    };
  }

  const wikipediaIdentity = parseWikipediaIdentity(url);
  if (wikipediaIdentity !== null) {
    return {
      platform: "WIKIPEDIA",
      externalId: wikipediaIdentity.externalId,
    };
  }

  return null;
}

export function isSupportedPostUrl(url: string): boolean {
  return parseSupportedPageIdentity(url) !== null;
}
