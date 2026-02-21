import type { Platform } from "@openerrata/shared";

const LESSWRONG_EXTERNAL_ID_RE =
  /(?:www\.)?lesswrong\.com\/posts\/([A-Za-z0-9]+)(?:\/[^/?#]*)?(?:[/?#]|$)/i;
const X_HANDLE_STATUS_RE = /(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/i;
const X_WEB_STATUS_RE = /(?:x\.com|twitter\.com)\/i\/web\/status\/(\d+)/i;
const X_I_STATUS_RE = /(?:x\.com|twitter\.com)\/i\/status\/(\d+)/i;
const SUBSTACK_POST_RE =
  /(?:[a-z0-9-]+\.)substack\.com\/p\/([^/?#]+)(?:[/?#]|$)/i;

export interface SupportedPageIdentity {
  platform: Platform;
  externalId: string;
}

export function parseSupportedPageIdentity(
  url: string,
): SupportedPageIdentity | null {
  const lesswrongMatch = url.match(LESSWRONG_EXTERNAL_ID_RE);
  if (lesswrongMatch?.[1]) {
    return {
      platform: "LESSWRONG",
      externalId: lesswrongMatch[1],
    };
  }

  const xHandleMatch = url.match(X_HANDLE_STATUS_RE);
  if (xHandleMatch?.[1]) {
    return {
      platform: "X",
      externalId: xHandleMatch[1],
    };
  }

  const xWebMatch = url.match(X_WEB_STATUS_RE);
  if (xWebMatch?.[1]) {
    return {
      platform: "X",
      externalId: xWebMatch[1],
    };
  }

  const xIStatusMatch = url.match(X_I_STATUS_RE);
  if (xIStatusMatch?.[1]) {
    return {
      platform: "X",
      externalId: xIStatusMatch[1],
    };
  }

  const substackMatch = url.match(SUBSTACK_POST_RE);
  if (substackMatch?.[1]) {
    return {
      platform: "SUBSTACK",
      externalId: substackMatch[1],
    };
  }

  return null;
}

export function isSupportedPostUrl(url: string): boolean {
  return parseSupportedPageIdentity(url) !== null;
}
