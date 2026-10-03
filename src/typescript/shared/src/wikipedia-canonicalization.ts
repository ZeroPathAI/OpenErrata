import { NON_CONTENT_TAGS, normalizeContent } from "./normalize.js";

// ---------------------------------------------------------------------------
// Shared heading detection for Wikipedia Parsoid and legacy HTML formats.
//
// Both the browser extension (DOM TreeWalker) and API server (parse5 traversal)
// need identical heading-level and heading-text logic to produce matching
// canonical output. These pure functions accept an environment-agnostic
// descriptor so both callers share one implementation — the same pattern
// used by shouldExcludeWikipediaElement below.
// ---------------------------------------------------------------------------

/**
 * Minimal descriptor that both DOM Elements and parse5 nodes can provide.
 * Used by the heading detection functions below.
 */
interface WikipediaElementDescriptor {
  tagName: string;
  classTokens: readonly string[];
}

/**
 * Descriptor sufficient for heading *level* detection (no text content needed).
 * Used by `effectiveHeadingLevel` which only inspects tag names and classes.
 */
export interface WikipediaHeadingLevelDescriptor extends WikipediaElementDescriptor {
  firstChildHeading: { tagName: string } | null;
}

/**
 * Full descriptor that also carries text content, needed for heading *text*
 * extraction and section-title exclusion checks.
 */
export interface WikipediaNodeDescriptor extends WikipediaElementDescriptor {
  /** Text content of this node (used for direct heading text). */
  textContent: string;
  /**
   * The first direct child element that is a heading tag (h2–h6), if any.
   * For Parsoid `<div class="mw-heading">` wrappers this is the inner `<h2>`.
   */
  firstChildHeading: { tagName: string; textContent: string } | null;
}

/** Parse an h2–h6 tag name to its numeric heading level, or null. */
export function headingLevelFromTag(tagName: string): number | null {
  const match = /^h([2-6])$/i.exec(tagName);
  return match?.[1] !== undefined ? Number(match[1]) : null;
}

/**
 * Returns true if `descriptor` is a Parsoid-style `<div class="mw-heading">`
 * wrapper that contains an inner heading element.
 */
function isParsoidHeadingWrapper(descriptor: WikipediaElementDescriptor): boolean {
  return (
    descriptor.tagName.toLowerCase() === "div" &&
    descriptor.classTokens.some((t) => t.toLowerCase() === "mw-heading")
  );
}

/**
 * Returns the heading level of a node, handling both direct heading elements
 * (`<h2>`, `<h3>`, …) and Parsoid-style `<div class="mw-heading">` wrappers
 * where the level comes from the inner child heading.
 *
 * Accepts `WikipediaHeadingLevelDescriptor` — callers need only provide tag
 * names and classes, not text content.
 */
export function effectiveHeadingLevel(node: WikipediaHeadingLevelDescriptor): number | null {
  const direct = headingLevelFromTag(node.tagName);
  if (direct !== null) return direct;
  if (isParsoidHeadingWrapper(node) && node.firstChildHeading !== null) {
    return headingLevelFromTag(node.firstChildHeading.tagName);
  }
  return null;
}

/**
 * Returns the text to use for section-title exclusion checks.
 * For Parsoid `<div class="mw-heading">` wrappers, reads the inner heading's
 * text (excluding sibling `<span class="mw-editsection">` spans). For direct
 * heading elements, checks for a `.mw-headline` child first (legacy format),
 * then falls back to the full text content.
 */
export function effectiveHeadingText(
  node: WikipediaNodeDescriptor,
  headlineTextContent?: string,
): string {
  if (isParsoidHeadingWrapper(node) && node.firstChildHeading !== null) {
    return node.firstChildHeading.textContent;
  }
  // Legacy format: prefer .mw-headline child text if the caller provides it.
  if (headlineTextContent !== undefined) {
    return headlineTextContent;
  }
  return node.textContent;
}

/**
 * Appendix sections that list citations, sources and outbound links rather
 * than carry article prose, by title (compared after
 * `normalizeWikipediaSectionTitle`). Section titles are the one signal here
 * that is per-language: these are the same kinds of section English excludes,
 * as titled on the largest Wikipedias, taken from the titles those wikis' own
 * articles use. A title matches on any wiki, since some wikis' articles use
 * another language's titles. "See also" sections and their equivalents stay:
 * English keeps them.
 */
const WIKIPEDIA_EXCLUDED_SECTION_TITLES_BY_LANGUAGE = {
  en: [
    "references",
    "notes",
    "further reading",
    "external links",
    "bibliography",
    "sources",
    "citations",
  ],
  de: [
    "einzelnachweise",
    "nachweise",
    "belege",
    "anmerkungen",
    "fußnoten",
    "literatur",
    "weiterführende literatur",
    "weblinks",
    "quellen",
  ],
  fr: ["notes et références", "références", "bibliographie", "liens externes", "lien externe"],
  es: [
    "referencias",
    "notas",
    "bibliografía",
    "bibliografía consultada",
    "bibliografía básica",
    "enlaces externos",
    "enlace externo",
    "fuentes",
    "fuente",
  ],
  it: ["note", "bibliografia", "collegamenti esterni", "altri progetti", "fonti"],
  pt: [
    "referências",
    "notas",
    "notas explicativas",
    "bibliografia",
    "leitura adicional",
    "ligações externas",
    "links externos",
    "fontes",
  ],
  nl: [
    "noten",
    "voetnoten",
    "referenties",
    "bronnen",
    "bronvermelding",
    "literatuur",
    "externe links",
    "externe link",
  ],
  pl: ["przypisy", "uwagi", "bibliografia", "dalsza literatura", "linki zewnętrzne"],
  ru: ["примечания", "комментарии", "литература", "библиография", "источники", "ссылки"],
  ja: ["脚注", "注釈", "出典", "参考文献", "参考", "読書案内", "外部リンク"],
  // zh.wikipedia serves each reader their script variant, so both forms occur.
  zh: [
    "注释",
    "註釋",
    "注解",
    "註解",
    "脚注",
    "腳註",
    "参考文献",
    "參考文獻",
    "参考资料",
    "參考資料",
    "参考来源",
    "參考來源",
    "参考",
    "參考",
    "来源",
    "來源",
    "延伸阅读",
    "延伸閱讀",
    "扩展阅读",
    "擴展閱讀",
    "进阶读物",
    "進階讀物",
    "外部链接",
    "外部鏈接",
    "外部連結",
  ],
} as const satisfies Record<string, readonly string[]>;

export const WIKIPEDIA_EXCLUDED_SECTION_TITLES: readonly string[] = Object.values(
  WIKIPEDIA_EXCLUDED_SECTION_TITLES_BY_LANGUAGE,
).flat();

/**
 * Class tokens of non-prose elements. The conventions MediaWiki and its
 * communities apply on every wiki come first; the per-wiki tokens after them
 * cover boxes those conventions miss.
 */
const WIKIPEDIA_EXCLUDED_CLASS_TOKENS = [
  // Navigation / metadata
  "mw-editsection",
  "catlinks",
  "printfooter",
  // References / footnotes
  "references",
  "mw-references-wrap",
  "reflist",
  // Navigation boxes (don't contain article prose)
  "noprint",
  "navbox",
  "vertical-navbox",
  // Blocks about the article rather than of it: maintenance and quality
  // banners, sister-project boxes, person-data tables, French "main article"
  // banners.
  "metadata",
  // What Wikimedia's search index leaves out as navigation: hatnotes ("For
  // other uses, see …"), navboxes, authority-control boxes.
  "navigation-not-searchable",
  // Per-wiki boxes that carry neither convention above: fr.wikipedia's portal
  // bar; nl.wikipedia's appendix box (sources, footnotes and external links
  // under bold labels rather than section headings) and sister-project boxes.
  "bandeau-portail",
  "appendix",
  "interproject",
  "interprojecttemplate",
  // Interactive UI injected by Wikipedia's JavaScript — not present in the
  // Wikipedia Parse API response and not article content.
  "mw-collapsible-toggle", // "show"/"hide" toggle buttons on collapsible infobox rows
  "mw-tmh-player", // Video/audio player wrapper added by TimedMediaHandler JS
  // (contains "Duration: N seconds." and time display)
  "cachelinks", // fr.wikipedia gadget appending "[archive]" (Wikiwix) after external links
] as const;

/**
 * ARIA roles of non-prose landmarks. Navboxes, series sidebars and "main
 * article" links declare `role="navigation"` on every wiki, whatever their
 * per-wiki class names.
 */
const WIKIPEDIA_EXCLUDED_ROLES = ["navigation"] as const;

const WIKIPEDIA_EXCLUDED_SECTION_TITLE_SET = new Set<string>(WIKIPEDIA_EXCLUDED_SECTION_TITLES);
const WIKIPEDIA_EXCLUDED_CLASS_TOKEN_SET = new Set<string>(WIKIPEDIA_EXCLUDED_CLASS_TOKENS);
const WIKIPEDIA_EXCLUDED_ROLE_SET = new Set<string>(WIKIPEDIA_EXCLUDED_ROLES);

export function normalizeWikipediaSectionTitle(value: string): string {
  return normalizeContent(value).toLowerCase();
}

export function isExcludedWikipediaSectionTitle(value: string): boolean {
  return WIKIPEDIA_EXCLUDED_SECTION_TITLE_SET.has(normalizeWikipediaSectionTitle(value));
}

function isExcludedWikipediaClassToken(token: string): boolean {
  return WIKIPEDIA_EXCLUDED_CLASS_TOKEN_SET.has(token.toLowerCase());
}

function isReferenceSupNode(tagName: string, classTokens: readonly string[]): boolean {
  return (
    tagName.toLowerCase() === "sup" &&
    classTokens.some((token) => token.toLowerCase() === "reference")
  );
}

function isExcludedWikipediaTag(tagName: string): boolean {
  return NON_CONTENT_TAGS.has(tagName.toLowerCase());
}

function isExcludedWikipediaRole(role: string | null): boolean {
  return role !== null && WIKIPEDIA_EXCLUDED_ROLE_SET.has(role.trim().toLowerCase());
}

/** What the exclusion predicate reads of an element, from a DOM Element or a parse5 node alike. */
interface WikipediaExclusionDescriptor extends WikipediaElementDescriptor {
  /** The `role` attribute, or null when the element has none. */
  role: string | null;
}

/**
 * Shared Wikipedia element exclusion predicate used by both the browser
 * adapter (DOM traversal) and API canonical fetcher (parse5 traversal).
 * Keeping this centralized prevents client/server canonicalization drift.
 * It reads only markup the Parse API returns and Wikipedia's scripts leave
 * alone (tags, classes, roles), never inline styles, which scripts and reader
 * interaction change on the live page.
 */
export function shouldExcludeWikipediaElement(input: WikipediaExclusionDescriptor): boolean {
  if (isExcludedWikipediaTag(input.tagName)) {
    return true;
  }

  if (isReferenceSupNode(input.tagName, input.classTokens)) {
    return true;
  }

  if (isExcludedWikipediaRole(input.role)) {
    return true;
  }

  return input.classTokens.some((token) => isExcludedWikipediaClassToken(token));
}
