import type { ExtensionPageStatus } from "@openerrata/shared";
import { isSamePage, knownHostPageLocator, pageLocatorFor } from "../lib/page-locator";

/**
 * Whether the tab may show a supported post: a post page on a platform host,
 * or a `/p/*` page on any host (custom-domain Substack is only confirmed by
 * the page's DOM, which the popup does not inspect).
 */
export function isPossiblySupportedPage(tabUrl: string): boolean {
  return knownHostPageLocator(tabUrl) !== null || pageLocatorFor("SUBSTACK", tabUrl) !== null;
}

/**
 * Whether a cached status describes the page the tab shows now. The cache can
 * briefly lag an in-page navigation; its page URL must name the same post as
 * the tab's URL.
 */
export function statusDescribesTabPage(status: ExtensionPageStatus, tabUrl: string): boolean {
  const tabPage = pageLocatorFor(status.platform, tabUrl);
  const statusPage = pageLocatorFor(status.platform, status.pageUrl);
  return tabPage !== null && statusPage !== null && isSamePage(tabPage, statusPage);
}
