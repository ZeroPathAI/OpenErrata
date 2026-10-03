import {
  effectiveHeadingLevel,
  effectiveHeadingText,
  headingLevelFromTag,
  isExcludedWikipediaSectionTitle,
  shouldExcludeWikipediaElement,
  type WikipediaHeadingLevelDescriptor,
  type WikipediaNodeDescriptor,
} from "@openerrata/shared";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";

type Parse5Node = DefaultTreeAdapterMap["node"];
/** Decides, per node of a fragment visited in document order, whether its subtree is kept. */
export type Parse5NodeFilter = (node: DefaultTreeAdapterMap["childNode"]) => "include" | "skip";

export function isElementNode(node: Parse5Node): node is DefaultTreeAdapterMap["element"] {
  return "tagName" in node;
}

export function isTextNode(node: Parse5Node): node is DefaultTreeAdapterMap["textNode"] {
  return node.nodeName === "#text";
}

export function hasChildren(node: Parse5Node): node is DefaultTreeAdapterMap["parentNode"] {
  return "childNodes" in node;
}

function attrValue(node: DefaultTreeAdapterMap["element"], name: string): string | null {
  const match = node.attrs.find((entry) => entry.name === name);
  return match?.value ?? null;
}

function classTokens(node: DefaultTreeAdapterMap["element"]): string[] {
  const classValue = attrValue(node, "class");
  if (classValue === null || classValue.length === 0) return [];
  return classValue
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function textContentOfNode(node: Parse5Node): string {
  if (isTextNode(node)) {
    return node.value;
  }
  if (!hasChildren(node)) {
    return "";
  }

  let text = "";
  for (const child of node.childNodes) {
    text += textContentOfNode(child);
  }
  return text;
}

function firstDirectChildHeadingNode(
  node: DefaultTreeAdapterMap["element"],
): DefaultTreeAdapterMap["element"] | null {
  for (const child of node.childNodes) {
    if (isElementNode(child) && headingLevelFromTag(child.tagName) !== null) {
      return child;
    }
  }
  return null;
}

/** Lightweight descriptor for heading *level* detection — no text content. */
function toHeadingLevelDescriptor(
  node: DefaultTreeAdapterMap["element"],
  classTokenValues: readonly string[],
  firstChildHeadingNode: DefaultTreeAdapterMap["element"] | null,
): WikipediaHeadingLevelDescriptor {
  return {
    tagName: node.tagName,
    classTokens: classTokenValues,
    firstChildHeading:
      firstChildHeadingNode !== null ? { tagName: firstChildHeadingNode.tagName } : null,
  };
}

/** Full descriptor with text content, for heading text extraction. */
function toNodeDescriptor(
  node: DefaultTreeAdapterMap["element"],
  classTokenValues: readonly string[],
  firstChildHeadingNode: DefaultTreeAdapterMap["element"] | null,
): WikipediaNodeDescriptor {
  return {
    tagName: node.tagName,
    classTokens: classTokenValues,
    textContent: textContentOfNode(node),
    firstChildHeading:
      firstChildHeadingNode !== null
        ? {
            tagName: firstChildHeadingNode.tagName,
            textContent: textContentOfNode(firstChildHeadingNode),
          }
        : null,
  };
}

function shouldSkipWikipediaElement(node: DefaultTreeAdapterMap["element"]): boolean {
  return shouldExcludeWikipediaElement({
    tagName: node.tagName,
    classTokens: classTokens(node),
    role: attrValue(node, "role"),
  });
}

/**
 * Creates a stateful node filter for Wikipedia content extraction and rendering,
 * for nodes visited in document order (pre-order, skipped subtrees not entered).
 *
 * This handles:
 * - element-level exclusion (e.g. citation superscripts, edit links, navboxes)
 * - section-level exclusion (e.g. "References", "External links"): an excluded
 *   heading (or its Parsoid `div.mw-heading` wrapper) and its following
 *   siblings, up to the next sibling heading of the same or a higher level —
 *   the extension's rule too (`sectionElements` in its Wikipedia adapter).
 *   Being sibling-based, it holds for flat Parse API output and for read views
 *   that nest each section in a `<section>` element alike.
 */
export function createWikipediaNodeFilter(): Parse5NodeFilter {
  let excludedSection: {
    parent: DefaultTreeAdapterMap["parentNode"] | null;
    level: number;
  } | null = null;

  return (node) => {
    // Pre-order traversal reaches a node outside the section's parent only
    // once it has left that parent for good.
    if (excludedSection !== null && node.parentNode !== excludedSection.parent) {
      excludedSection = null;
    }

    const headingLevel = isElementNode(node) ? headingLevelOf(node) : null;
    if (excludedSection !== null) {
      if (headingLevel === null || headingLevel > excludedSection.level) {
        return "skip";
      }
      excludedSection = null;
    }

    if (!isElementNode(node)) {
      return "include";
    }
    if (shouldSkipWikipediaElement(node)) {
      return "skip";
    }
    if (headingLevel !== null && hasExcludedSectionTitle(node)) {
      excludedSection = { parent: node.parentNode, level: headingLevel };
      return "skip";
    }
    return "include";
  };
}

/** The level of the section `node` opens (a heading or Parsoid heading wrapper), or null. */
function headingLevelOf(node: DefaultTreeAdapterMap["element"]): number | null {
  return effectiveHeadingLevel(
    toHeadingLevelDescriptor(node, classTokens(node), firstDirectChildHeadingNode(node)),
  );
}

/** Whether the heading (or heading wrapper) `node` titles an excluded section. */
function hasExcludedSectionTitle(node: DefaultTreeAdapterMap["element"]): boolean {
  const headingText = effectiveHeadingText(
    toNodeDescriptor(node, classTokens(node), firstDirectChildHeadingNode(node)),
  );
  return isExcludedWikipediaSectionTitle(headingText);
}

/**
 * Strip excluded Wikipedia sections/elements from a parse5 tree in place.
 */
function stripExcludedWikipediaNodes(fragment: DefaultTreeAdapterMap["parentNode"]): void {
  const nodeFilter = createWikipediaNodeFilter();

  const collectRemovals = (parent: DefaultTreeAdapterMap["parentNode"]): void => {
    const indicesToRemove: number[] = [];

    for (let index = 0; index < parent.childNodes.length; index += 1) {
      const node = parent.childNodes[index];
      if (node === undefined) continue;

      if (nodeFilter(node) === "skip") {
        indicesToRemove.push(index);
        continue;
      }

      if (isElementNode(node) && hasChildren(node)) {
        collectRemovals(node);
      }
    }

    // Remove in reverse index order so earlier indices stay valid.
    for (let i = indicesToRemove.length - 1; i >= 0; i -= 1) {
      const indexToRemove = indicesToRemove[i];
      if (indexToRemove !== undefined) {
        parent.childNodes.splice(indexToRemove, 1);
      }
    }
  };

  collectRemovals(fragment);
}

export function preFilterWikipediaHtml(html: string): string {
  const fragment = parseFragment(html);
  stripExcludedWikipediaNodes(fragment);
  return serialize(fragment);
}
