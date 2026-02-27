import { normalizeContent } from "@openerrata/shared";
import { isLikelyVisible, type AdapterExtractionResult, type PlatformAdapter } from "./model";
import {
  extractContentWithImageOccurrencesFromRoot,
  readFirstMetaDateAsIso,
  readFirstTimeDateAsIso,
  readPublishedDateFromJsonLd,
} from "./utils";

const POST_URL_REGEX =
  /(?:www\.)?lesswrong\.com\/posts\/([A-Za-z0-9]+)(?:\/([^/?#]*))?(?:[/?#]|$)/i;

const CONTENT_SELECTOR = ".PostsPage-postContent";
const POST_AUTHOR_LINK_SELECTORS = [
  '.PostsAuthors-authorName a[href*="/users/"]',
  '.LWPostsPageHeader-authorInfo a[href*="/users/"]',
  '.PostsAuthors-root a[href*="/users/"]',
] as const;
const TAG_SELECTOR = 'a[href*="/tag/"]';
const JSON_LD_SELECTOR = 'script[type="application/ld+json"]';
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
  const match = href.match(/\/users\/([^/?#]+)/);
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

function toCanonicalVersioningHtml(canonicalRoot: Element): string {
  const clone = canonicalRoot.cloneNode(true) as Element;
  removeLinkPostCallouts(clone);

  return (clone as HTMLElement).innerHTML;
}

function removeLinkPostCallouts(root: Element): void {
  // LessWrong linkposts prepend a client-rendered callout block that is not
  // present in GraphQL `contents.html`, so include only canonical post HTML.
  root.querySelectorAll(".LinkPostMessage-root").forEach((node) => {
    node.remove();
  });
}

function extractPostIdFromUrl(url: string): string | null {
  const match = url.match(POST_URL_REGEX);
  return match?.[1] ?? null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scriptPrimaryPostId(script: HTMLScriptElement): string | null {
  const text = script.textContent;
  if (text.length === 0) return null;

  try {
    const parsed = JSON.parse(text) as unknown;
    const candidates = isUnknownArray(parsed) ? parsed : [parsed];
    for (const candidate of candidates) {
      if (!isUnknownRecord(candidate)) continue;
      const maybeUrl = candidate["url"];
      if (typeof maybeUrl !== "string") continue;
      const postId = extractPostIdFromUrl(maybeUrl);
      if (postId !== null && postId.length > 0) {
        return postId;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function bodyPrimaryPostIds(contentRoot: Element): string[] {
  const postBody = contentRoot.closest("#postBody");
  if (!postBody) return [];

  const ids = new Set<string>();
  for (const script of postBody.querySelectorAll<HTMLScriptElement>(JSON_LD_SELECTOR)) {
    const postId = scriptPrimaryPostId(script);
    if (postId !== null && postId.length > 0) {
      ids.add(postId);
    }
  }

  return Array.from(ids);
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

  const isJsdom =
    document.defaultView?.navigator.userAgent.toLowerCase().includes("jsdom") === true;

  const withCanonicalRoot = roots.filter((root) => findCanonicalRootWithin(root) !== null);
  const canonicalCandidates = withCanonicalRoot.length > 0 ? withCanonicalRoot : roots;

  const identityMatches = canonicalCandidates.filter((root) => bodyMatchesPostId(root, externalId));
  const visibleIdentityMatches = identityMatches.filter((root) => isLikelyVisible(root));

  if (visibleIdentityMatches.length === 1) {
    const selectedRoot = visibleIdentityMatches[0];
    if (!selectedRoot) {
      throw new Error("Expected one visible identity-matching LessWrong root");
    }
    return {
      kind: "ready",
      root: selectedRoot,
    };
  }

  if (visibleIdentityMatches.length > 1) {
    return {
      kind: "not_ready",
      reason: "ambiguous_dom",
    };
  }

  if (identityMatches.length > 1) {
    return {
      kind: "not_ready",
      reason: "ambiguous_dom",
    };
  }

  if (identityMatches.length === 1) {
    const selectedRoot = identityMatches[0];
    if (!selectedRoot) {
      throw new Error("Expected one identity-matching LessWrong root");
    }
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

  if (!isJsdom) {
    // Wait for LessWrong's JSON-LD post identity before extracting so we
    // never hash transitional DOM from a different post during SPA switches.
    return {
      kind: "not_ready",
      reason: "hydrating",
    };
  }

  const visibleCandidates = canonicalCandidates.filter((root) => isLikelyVisible(root));
  if (visibleCandidates.length === 1) {
    const selectedRoot = visibleCandidates[0];
    if (!selectedRoot) {
      throw new Error("Expected one visible LessWrong candidate root");
    }
    return {
      kind: "ready",
      root: selectedRoot,
    };
  }

  if (visibleCandidates.length > 1 || canonicalCandidates.length > 1) {
    return {
      kind: "not_ready",
      reason: "ambiguous_dom",
    };
  }

  const selectedRoot = canonicalCandidates[0];
  if (!selectedRoot) {
    return {
      kind: "not_ready",
      reason: "hydrating",
    };
  }
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

export const lesswrongAdapter: PlatformAdapter = {
  platformKey: "LESSWRONG",
  contentRootSelector: CONTENT_SELECTOR,

  matches(url: string): boolean {
    return POST_URL_REGEX.test(url);
  },

  extract(document: Document): AdapterExtractionResult {
    const url = window.location.href;
    const match = url.match(POST_URL_REGEX);
    const externalId = match?.[1];
    if (externalId === undefined || externalId.length === 0) {
      return {
        kind: "not_ready",
        reason: "missing_identity",
      };
    }

    const rootSelection = pickContentRoot(document, externalId);
    if (rootSelection.kind !== "ready") {
      return nonReadyFromRootSelection({
        rootSelection,
      });
    }

    const canonicalRoot = findCanonicalRootWithin(rootSelection.root);
    if (!canonicalRoot) {
      return {
        kind: "not_ready",
        reason: "hydrating",
      };
    }
    const canonicalVersioningHtml = toCanonicalVersioningHtml(canonicalRoot);
    const canonicalExtractionRoot = canonicalRoot.cloneNode(true) as Element;
    removeLinkPostCallouts(canonicalExtractionRoot);
    const extractedContent = extractContentWithImageOccurrencesFromRoot(
      canonicalExtractionRoot,
      url,
    );
    const contentText = extractedContent.contentText;
    const postScope = rootSelection.root.closest("#postBody") ?? document;
    const title = pickTitle(postScope, document.title);

    const authorLink = findPostAuthorLink(postScope);
    const normalizedAuthorName = normalizeContent(authorLink?.textContent ?? "");
    const authorName = normalizedAuthorName.length > 0 ? normalizedAuthorName : null;
    const authorSlug = parseAuthorSlug(authorLink?.getAttribute("href") ?? null);

    const tags = Array.from(postScope.querySelectorAll(TAG_SELECTOR))
      .map((el) => normalizeContent(el.textContent))
      .filter(Boolean);
    const slugToken = match?.[2];
    const normalizedSlug = slugToken === undefined ? "" : normalizeContent(slugToken);
    const slug = normalizedSlug.length > 0 ? normalizedSlug : externalId;
    const publishedAt = extractPublishedAt(document, postScope);

    const imageUrls = extractedContent.imageUrls;
    const hasVideoMedia = canonicalRoot.querySelector("video, iframe") !== null;
    const mediaState =
      imageUrls.length > 0 ? "has_images" : hasVideoMedia ? "has_video" : "text_only";
    const metadata = {
      slug,
      htmlContent: canonicalVersioningHtml,
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
        externalId,
        url,
        contentText,
        mediaState,
        imageUrls,
        imageOccurrences: extractedContent.imageOccurrences,
        metadata,
      },
    };
  },

  getContentRoot(document: Document): Element | null {
    const url = window.location.href;
    const externalId = extractPostIdFromUrl(url);
    if (externalId === null || externalId.length === 0) {
      return null;
    }

    const rootSelection = pickContentRoot(document, externalId);
    if (rootSelection.kind !== "ready") {
      return null;
    }

    return findCanonicalRootWithin(rootSelection.root);
  },
};
