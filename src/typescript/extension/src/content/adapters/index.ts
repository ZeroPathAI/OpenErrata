import { lesswrongAdapter } from "./lesswrong";
import type { PlatformAdapter } from "./model";
import { substackAdapter } from "./substack";
import { wikipediaAdapter } from "./wikipedia";
import { xAdapter } from "./x";

const adapters: PlatformAdapter[] = [lesswrongAdapter, xAdapter, substackAdapter, wikipediaAdapter];

/**
 * Return the first adapter whose `matches()` predicate is true for the
 * given URL, or `null` if no adapter handles this page.
 */
export function getAdapter(url: string, documentForDetection?: Document): PlatformAdapter | null {
  const fromUrl = adapters.find((adapter) => adapter.matches(url));
  if (fromUrl) {
    return fromUrl;
  }

  if (!documentForDetection) {
    return null;
  }

  return adapters.find((adapter) => adapter.detectFromDom?.(documentForDetection) === true) ?? null;
}

export type { PlatformAdapter };
