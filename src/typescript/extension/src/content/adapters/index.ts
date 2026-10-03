import type { PageLocator } from "../../lib/page-locator";
import { lesswrongAdapter } from "./lesswrong";
import type { PlatformAdapter } from "./model";
import { substackAdapter } from "./substack";
import { wikipediaAdapter } from "./wikipedia";
import { xAdapter } from "./x";

const adapters: readonly PlatformAdapter[] = [
  lesswrongAdapter,
  xAdapter,
  substackAdapter,
  wikipediaAdapter,
];

/** The adapter for the current page, with what the URL says about the post it shows. */
interface SelectedAdapter {
  adapter: PlatformAdapter;
  locator: PageLocator;
}

/**
 * Adapter selection (spec §3.8): URL-first (`matches`), then the DOM
 * fingerprint fallback for platform pages on custom domains.
 */
export function selectAdapter(url: string, document: Document): SelectedAdapter | null {
  const adapter =
    adapters.find((candidate) => candidate.matches(url)) ??
    adapters.find((candidate) => candidate.detectFromDom?.(document) === true);
  if (adapter === undefined) {
    return null;
  }
  const locator = adapter.pageLocator(url);
  if (locator === null) {
    throw new Error(`${adapter.platformKey} adapter selected a page it cannot locate: ${url}`);
  }
  return { adapter, locator };
}

export type { PlatformAdapter };
