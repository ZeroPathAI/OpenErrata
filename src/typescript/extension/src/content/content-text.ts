import type { PlatformAdapter } from "./adapters/index.js";
import { buildDomTextIndex, type DomTextIndex } from "./dom-text-index.js";

/**
 * The text index of the adapter's content root as it is in the DOM now, or
 * null while the root is absent. Built exactly as adapters build the content
 * text they report, so it can be compared with that text and claims located
 * in it.
 */
export function contentTextIndexOf(
  adapter: PlatformAdapter,
  document: Document,
): DomTextIndex | null {
  const root = adapter.getContentRoot(document);
  if (root === null) return null;
  return buildDomTextIndex(root, { exclude: adapter.contentExclusionFilter(root) });
}
