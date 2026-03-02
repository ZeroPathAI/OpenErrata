import {
  effectiveHeadingLevel,
  effectiveHeadingText,
  headingLevelFromTag,
  isExcludedWikipediaSectionTitle,
  normalizeWikipediaSectionTitle,
  shouldExcludeWikipediaElement,
  type WikipediaHeadingLevelDescriptor,
  type WikipediaNodeDescriptor,
} from "@openerrata/shared";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";

export type Parse5Node = DefaultTreeAdapterMap["node"];
export type Parse5NodeFilter = (node: Parse5Node) => "include" | "skip";

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
  });
}

/**
 * Creates a stateful node filter for Wikipedia content extraction and rendering.
 *
 * This handles:
 * - section-level exclusion (e.g. "References", "External links")
 * - element-level exclusion (e.g. citation superscripts, edit links)
 * - text-node suppression while inside an excluded section
 */
export function createWikipediaNodeFilter(): Parse5NodeFilter {
  let skipSectionLevel: number | null = null;

  return (node: Parse5Node): "include" | "skip" => {
    if (isElementNode(node)) {
      const classTokenValues = classTokens(node);
      const firstChildHeadingNode = firstDirectChildHeadingNode(node);
      const nodeHeadingLevel = effectiveHeadingLevel(
        toHeadingLevelDescriptor(node, classTokenValues, firstChildHeadingNode),
      );
      if (nodeHeadingLevel !== null) {
        if (skipSectionLevel !== null && nodeHeadingLevel <= skipSectionLevel) {
          skipSectionLevel = null;
        }

        const headingText = normalizeWikipediaSectionTitle(
          effectiveHeadingText(toNodeDescriptor(node, classTokenValues, firstChildHeadingNode)),
        );
        if (isExcludedWikipediaSectionTitle(headingText)) {
          skipSectionLevel = nodeHeadingLevel;
          return "skip";
        }
      }

      if (skipSectionLevel !== null || shouldSkipWikipediaElement(node)) {
        return "skip";
      }

      return "include";
    }

    // Text nodes: suppress when inside an excluded section.
    if (skipSectionLevel !== null) {
      return "skip";
    }

    return "include";
  };
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
