import { isNonNullObject, lesswrongExternalIdSchema, normalizeContent } from "@openerrata/shared";
import { pageLocatorFor, type PageLocator } from "../../lib/page-locator";
import { isLikelyVisible, type AdapterExtractionResult, type PlatformAdapter } from "./model";
import {
  extractContent,
  hasVideoContent,
  readFirstMetaDateAsIso,
  readFirstTimeDateAsIso,
  readJsonLdBlocks,
  readPublishedDateFromJsonLd,
  serializeContentHtml,
} from "./utils";

const CONTENT_SELECTOR = ".PostsPage-postContent";
// LessWrong linkposts prepend a client-rendered callout block that is not
// present in GraphQL `contents.html` (the API's canonical source).
const LINK_POST_CALLOUT_CLASS = "LinkPostMessage-root";
const POST_AUTHOR_LINK_SELECTORS = [
  '.PostsAuthors-authorName a[href*="/users/"]',
  '.LWPostsPageHeader-authorInfo a[href*="/users/"]',
  '.PostsAuthors-root a[href*="/users/"]',
] as const;
// Tag chips link to the tag's wiki page (`/w/<slug>` since LessWrong's 2025
// wiki merge; `/tag/<slug>` before). Scoped to the chip so in-body wiki links
// are not mistaken for tags.
const TAG_SELECTOR = '.FooterTag-root a[href^="/w/"], .FooterTag-root a[href*="/tag/"]';
const META_DATE_SELECTORS = [
  'meta[property="article:published_time"]',
  'meta[name="article:published_time"]',
  'meta[property="og:article:published_time"]',
  'meta[name="date"]',
  'meta[name="pubdate"]',
] as const;
const JSON_LD_DATE_KEYS = new Set(["datePublished", "dateCreated"]);

type RootSelectionResult =
  | {
      kind: "ready";
      root: Element;
    }
  | {
      kind: "not_ready";
      reason: "hydrating" | "missing_identity" | "ambiguous_dom";
    };

function parseAuthorSlug(href: string | null): string | null {
  if (href === null || href.length === 0) return null;
  const match = /\/users\/([^/?#]+)/.exec(href);
  return match?.[1] ?? null;
}

function extractPublishedAt(document: Document, postScope: ParentNode): string | null {
  return (
    readFirstMetaDateAsIso(document, META_DATE_SELECTORS) ??
    readPublishedDateFromJsonLd(postScope, JSON_LD_DATE_KEYS) ??
    readPublishedDateFromJsonLd(document, JSON_LD_DATE_KEYS) ??
    readFirstTimeDateAsIso([postScope, document])
  );
}

function findPostAuthorLink(scope: ParentNode): HTMLAnchorElement | null {
  for (const selector of POST_AUTHOR_LINK_SELECTORS) {
    const match = scope.querySelector<HTMLAnchorElement>(selector);
    if (match !== null) {
      return match;
    }
  }
  return null;
}

type LesswrongLocator = Extract<PageLocator, { platform: "LESSWRONG" }>;

function lesswrongLocator(url: string): LesswrongLocator | null {
  const locator = pageLocatorFor("LESSWRONG", url);
  return locator?.platform === "LESSWRONG" ? locator : null;
}

function isLinkPostCallout(element: Element): boolean {
  return element.classList.contains(LINK_POST_CALLOUT_CLASS);
}

/** Post IDs a JSON-LD block names as its primary entity (`url` fields of post pages). */
function jsonLdPrimaryPostIds(block: unknown): string[] {
  const candidates: unknown[] = Array.isArray(block) ? block : [block];
  return candidates.flatMap((candidate) => {
    if (!isNonNullObject(candidate)) return [];
    const url = candidate["url"];
    if (typeof url !== "string") return [];
    const locator = lesswrongLocator(url);
    return locator === null ? [] : [locator.postId];
  });
}

function bodyPrimaryPostIds(contentRoot: Element): string[] {
  const postBody = contentRoot.closest("#postBody");
  if (!postBody) return [];

  return Array.from(new Set(readJsonLdBlocks(postBody).flatMap(jsonLdPrimaryPostIds)));
}

function bodyMatchesPostId(contentRoot: Element, externalId: string): boolean {
  return bodyPrimaryPostIds(contentRoot).includes(externalId);
}

function bodyHasAnyPostIdentity(contentRoot: Element): boolean {
  return bodyPrimaryPostIds(contentRoot).length > 0;
}

function findCanonicalRootWithin(contentRoot: Element): Element | null {
  if (contentRoot.id === "postContent") {
    return contentRoot;
  }

  const queue: Element[] = Array.from(contentRoot.children);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (current.id === "postContent") {
      return current;
    }
    queue.push(...Array.from(current.children));
  }

  return null;
}

function pickContentRoot(document: Document, externalId: string): RootSelectionResult {
  const roots = Array.from(document.querySelectorAll(CONTENT_SELECTOR));

  if (roots.length === 0) {
    return {
      kind: "not_ready",
      reason: "hydrating",
    };
  }

  const withCanonicalRoot = roots.filter((root) => findCanonicalRootWithin(root) !== null);
  const canonicalCandidates = withCanonicalRoot.length > 0 ? withCanonicalRoot : roots;

  const identityMatches = canonicalCandidates.filter((root) => bodyMatchesPostId(root, externalId));
  const visibleIdentityMatches = identityMatches.filter((root) => isLikelyVisible(root));

  const [onlyVisibleMatch] = visibleIdentityMatches;
  if (visibleIdentityMatches.length === 1 && onlyVisibleMatch !== undefined) {
    return {
      kind: "ready",
      root: onlyVisibleMatch,
    };
  }

  if (visibleIdentityMatches.length > 1 || identityMatches.length > 1) {
    return {
      kind: "not_ready",
      reason: "ambiguous_dom",
    };
  }

  if (identityMatches.length === 1) {
    // The post's body is in the DOM but not rendered yet.
    return {
      kind: "not_ready",
      reason: "hydrating",
    };
  }

  if (canonicalCandidates.some((candidate) => bodyHasAnyPostIdentity(candidate))) {
    return {
      kind: "not_ready",
      reason: "missing_identity",
    };
  }

  // Wait for LessWrong's JSON-LD post identity before extracting so we never
  // hash transitional DOM from a different post during SPA switches.
  return {
    kind: "not_ready",
    reason: "hydrating",
  };
}

function pickTitle(scope: ParentNode, fallbackTitle: string): string | null {
  const headingTitles = Array.from(scope.querySelectorAll("h1"))
    .map((heading) => normalizeContent(heading.textContent))
    .filter(Boolean);
  const bestHeading = headingTitles.sort((left, right) => right.length - left.length)[0];
  if (bestHeading !== undefined && bestHeading.length > 0) {
    return bestHeading;
  }

  const normalizedFallback = normalizeContent(fallbackTitle.replace(/\s*[|·]\s*LessWrong.*$/i, ""));
  return normalizedFallback.length > 0 ? normalizedFallback : null;
}

function nonReadyFromRootSelection(input: {
  rootSelection: Extract<RootSelectionResult, { kind: "not_ready" }>;
}): AdapterExtractionResult {
  return {
    kind: "not_ready",
    reason: input.rootSelection.reason,
  };
}

function contentExclusionFilter(): (element: Element) => boolean {
  return isLinkPostCallout;
}

/** The canonical post body (`#postContent`) of the post the URL names, once it is unambiguous. */
function canonicalContentRoot(document: Document, externalId: string): RootSelectionResult {
  const rootSelection = pickContentRoot(document, externalId);
  if (rootSelection.kind !== "ready") {
    return rootSelection;
  }
  const canonicalRoot = findCanonicalRootWithin(rootSelection.root);
  return canonicalRoot === null
    ? { kind: "not_ready", reason: "hydrating" }
    : { kind: "ready", root: canonicalRoot };
}

export const lesswrongAdapter: PlatformAdapter = {
  platformKey: "LESSWRONG",

  matches(url: string): boolean {
    return lesswrongLocator(url) !== null;
  },

  pageLocator(url: string): PageLocator | null {
    return lesswrongLocator(url);
  },

  extract(document: Document): AdapterExtractionResult {
    const url = window.location.href;
    const locator = lesswrongLocator(url);
    if (locator === null) {
      return {
        kind: "not_ready",
        reason: "missing_identity",
      };
    }
    const externalId = locator.postId;

    const rootSelection = canonicalContentRoot(document, externalId);
    if (rootSelection.kind !== "ready") {
      return nonReadyFromRootSelection({ rootSelection });
    }
    const canonicalRoot = rootSelection.root;
    const extractedContent = extractContent(canonicalRoot, {
      exclude: contentExclusionFilter(),
      imageSelector: "img[src]",
      baseUrl: url,
    });
    const postScope = canonicalRoot.closest("#postBody") ?? document;
    const title = pickTitle(postScope, document.title);

    const authorLink = findPostAuthorLink(postScope);
    const normalizedAuthorName = normalizeContent(authorLink?.textContent ?? "");
    const authorName = normalizedAuthorName.length > 0 ? normalizedAuthorName : null;
    const authorSlug = parseAuthorSlug(authorLink?.getAttribute("href") ?? null);

    // The header and the footer both render the tag list.
    const tags = Array.from(
      new Set(
        Array.from(postScope.querySelectorAll(TAG_SELECTOR))
          .map((el) => normalizeContent(el.textContent))
          .filter(Boolean),
      ),
    );
    const normalizedSlug = locator.slug === null ? "" : normalizeContent(locator.slug);
    const slug = normalizedSlug.length > 0 ? normalizedSlug : externalId;
    const publishedAt = extractPublishedAt(document, postScope);

    const metadata = {
      slug,
      htmlContent: serializeContentHtml(canonicalRoot, contentExclusionFilter),
      authorSlug,
      tags,
      ...(title === null ? {} : { title }),
      ...(authorName === null ? {} : { authorName }),
      ...(publishedAt === null ? {} : { publishedAt }),
    };

    return {
      kind: "ready",
      content: {
        platform: "LESSWRONG",
        externalId: lesswrongExternalIdSchema.parse(externalId),
        url,
        contentText: extractedContent.contentText,
        hasVideo: hasVideoContent(canonicalRoot),
        imageOccurrences: extractedContent.imageOccurrences,
        metadata,
      },
    };
  },

  getContentRoot(document: Document): Element | null {
    const locator = lesswrongLocator(window.location.href);
    if (locator === null) {
      return null;
    }
    const rootSelection = canonicalContentRoot(document, locator.postId);
    return rootSelection.kind === "ready" ? rootSelection.root : null;
  },

  contentExclusionFilter,
};
