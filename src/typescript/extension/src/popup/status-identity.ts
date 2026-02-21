import type { ExtensionPageStatus } from "@openerrata/shared";
import type { SupportedPageIdentity } from "../lib/post-identity";

const SUBSTACK_POST_PATH_REGEX = /^\/p\/[^/?#]+/i;

export function isSubstackPostPathUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return SUBSTACK_POST_PATH_REGEX.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function statusMatchesIdentity(
  status: ExtensionPageStatus | null,
  identity: SupportedPageIdentity | null,
  tabUrl: string,
): boolean {
  if (!status) return true;

  // Substack externalId is numeric and not URL-derived, so URL identity for custom
  // domains is anchored by page URL path equality.
  if (status.platform === "SUBSTACK") {
    if (!isSubstackPostPathUrl(tabUrl)) return false;
    try {
      const tabParsed = new URL(tabUrl);
      const statusParsed = new URL(status.pageUrl);
      if (
        !SUBSTACK_POST_PATH_REGEX.test(statusParsed.pathname) ||
        tabParsed.origin !== statusParsed.origin ||
        tabParsed.pathname !== statusParsed.pathname
      ) {
        return false;
      }
    } catch {
      return false;
    }

    if (!identity) return true;
    return identity.platform === "SUBSTACK";
  }

  if (!identity) return false;

  return (
    status.platform === identity.platform &&
    status.externalId === identity.externalId
  );
}
