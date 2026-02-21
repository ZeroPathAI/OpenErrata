import type { InvestigationClaim } from "@truesight/shared";
import type { DomAnnotation } from "./dom-mapper";

const SAFE_SOURCE_PROTOCOLS = new Set(["http:", "https:"]);
const TOOLTIP_MARGIN_PX = 12;
const TOOLTIP_GAP_PX = 8;
const TOOLTIP_MIN_WIDTH_PX = 260;
const TOOLTIP_MAX_WIDTH_PX = 680;
type ThemeMode = "light" | "dark";
let activeDetailPanel: HTMLDivElement | null = null;
let disposeActiveDetailPanel: (() => void) | null = null;

function dismissDetailPanel(): void {
  disposeActiveDetailPanel?.();
  disposeActiveDetailPanel = null;
  if (activeDetailPanel?.isConnected) {
    activeDetailPanel.remove();
  }
  activeDetailPanel = null;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Render annotations by wrapping matched DOM ranges in highlight marks
 * and attaching tooltip / click behaviour.
 */
export function renderAnnotations(annotations: DomAnnotation[]): void {
  for (const annotation of annotations) {
    if (!annotation.matched || !annotation.range) continue;

    try {
      // Try the simple path: surroundContents works when the range is
      // contained entirely within a single DOM element.
      const mark = createMarkElement(annotation.claim);
      annotation.range.surroundContents(mark);
      attachInteractions(mark, annotation.claim);
    } catch {
      // surroundContents throws when the range crosses element
      // boundaries.  Fall back to highlighting individual text-node
      // fragments.
      highlightFragments(annotation.range, annotation.claim);
    }
  }
}

/**
 * Remove every annotation and tooltip previously injected by TrueSight.
 */
export function clearAnnotations(): void {
  // Unwrap <mark> elements, restoring their text-node children
  document.querySelectorAll(".truesight-annotation").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parent.normalize(); // merge adjacent text nodes
  });

  dismissDetailPanel();

  // Remove lingering tooltip and detail-panel elements
  document
    .querySelectorAll(".truesight-tooltip, .truesight-detail-panel")
    .forEach((el) => el.remove());
}

/**
 * Show a slide-in detail panel with the full explanation and source links
 * for a single claim.
 */
function showDetailPanel(
  claim: InvestigationClaim,
  anchor: HTMLElement | null = null,
): void {
  dismissDetailPanel();

  const panel = document.createElement("div");
  panel.className = "truesight-detail-panel";
  applyThemeClass(panel, detectThemeFromAnchor(anchor));

  const closeBtn = document.createElement("button");
  closeBtn.className = "close-btn";
  closeBtn.textContent = "\u00d7"; // ×
  panel.appendChild(closeBtn);

  const heading = document.createElement("h3");
  heading.textContent = "TrueSight — Claim Details";
  panel.appendChild(heading);

  const claimText = document.createElement("div");
  claimText.className = "claim-text";
  claimText.textContent = claim.text;
  panel.appendChild(claimText);

  const reasoning = document.createElement("div");
  reasoning.className = "reasoning";
  const reasoningHeading = document.createElement("h4");
  reasoningHeading.textContent = "Explanation";
  reasoning.appendChild(reasoningHeading);
  const reasoningBody = document.createElement("div");
  reasoningBody.innerHTML = renderMarkdownToHtml(claim.reasoning);
  reasoning.appendChild(reasoningBody);
  panel.appendChild(reasoning);

  if (claim.sources.length > 0) {
    const sourcesHeading = document.createElement("h4");
    sourcesHeading.textContent = "Sources";
    panel.appendChild(sourcesHeading);

    for (const source of claim.sources) {
      const div = document.createElement("div");
      div.className = "source";
      const safeUrl = toSafeSourceUrl(source.url);
      if (safeUrl) {
        const link = document.createElement("a");
        link.href = safeUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = source.title;
        div.appendChild(link);
      } else {
        const title = document.createElement("span");
        title.textContent = source.title;
        div.appendChild(title);
      }

      if (source.snippet) {
        const snippet = document.createElement("p");
        snippet.textContent = source.snippet;
        snippet.style.fontSize = "12px";
        snippet.style.opacity = "0.8";
        snippet.style.marginTop = "2px";
        div.appendChild(snippet);
      }

      panel.appendChild(div);
    }
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closePanel();
    }
  };
  const onDetached = new MutationObserver(() => {
    if (!panel.isConnected) {
      if (activeDetailPanel === panel) {
        dismissDetailPanel();
        return;
      }
      document.removeEventListener("keydown", onKey);
      onDetached.disconnect();
    }
  });
  onDetached.observe(document.body, { childList: true, subtree: true });

  const closePanel = () => {
    if (activeDetailPanel === panel) {
      dismissDetailPanel();
      return;
    }
    if (panel.isConnected) {
      panel.remove();
    }
  };

  closeBtn.addEventListener("click", closePanel);
  disposeActiveDetailPanel = () => {
    document.removeEventListener("keydown", onKey);
    onDetached.disconnect();
  };
  activeDetailPanel = panel;

  document.addEventListener("keydown", onKey);
  document.body.appendChild(panel);
}

// ── Markdown rendering ───────────────────────────────────────────────────

/**
 * Convert a subset of Markdown (bold, italic, inline code, lists, paragraphs)
 * to HTML.  Input is first stripped of any raw HTML tags as a defense-in-depth
 * measure — the content comes from our own API, but the LLM could in theory
 * emit `<script>` or similar.
 */
function renderMarkdownToHtml(md: string): string {
  // Strip raw HTML tags
  const stripped = md.replace(/<[^>]*>/g, "");

  const blocks = stripped.split(/\n{2,}/);
  const rendered: string[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");

    // Ordered list: every line starts with `\d+. `
    if (lines.every((l) => /^\d+\.\s/.test(l))) {
      const items = lines.map((l) => `<li>${inlineMarkdown(l.replace(/^\d+\.\s/, ""))}</li>`);
      rendered.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Unordered list: every line starts with `- `
    if (lines.every((l) => /^-\s/.test(l))) {
      const items = lines.map((l) => `<li>${inlineMarkdown(l.replace(/^-\s/, ""))}</li>`);
      rendered.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Regular paragraph — preserve single newlines as <br>
    rendered.push(`<p>${lines.map(inlineMarkdown).join("<br>")}</p>`);
  }

  return rendered.join("");
}

/** Apply inline Markdown formatting: bold, italic, inline code. */
function inlineMarkdown(text: string): string {
  return (
    text
      // inline code (must come before bold/italic to avoid conflicts inside backticks)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      // bold
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      // italic
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
  );
}

// ── Internal helpers ──────────────────────────────────────────────────────

function toSafeSourceUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!SAFE_SOURCE_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function createMarkElement(claim: InvestigationClaim): HTMLElement {
  const mark = document.createElement("mark");
  mark.className = "truesight-annotation";
  mark.setAttribute("aria-label", `TrueSight claim highlight: ${claim.summary}`);
  return mark;
}

function attachInteractions(
  mark: HTMLElement,
  claim: InvestigationClaim,
): void {
  let tooltip: HTMLDivElement | null = null;

  mark.addEventListener("mouseenter", () => {
    tooltip = createTooltip(claim, mark);
  });

  mark.addEventListener("mouseleave", () => {
    tooltip?.remove();
    tooltip = null;
  });

  mark.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showDetailPanel(claim, mark);
  });
}

function createTooltip(
  claim: InvestigationClaim,
  anchor: HTMLElement,
): HTMLDivElement {
  // Remove any stale tooltips
  document.querySelectorAll(".truesight-tooltip").forEach((el) => el.remove());

  const tip = document.createElement("div");
  tip.className = "truesight-tooltip";
  applyThemeClass(tip, detectThemeFromAnchor(anchor));
  tip.style.visibility = "hidden";

  const summary = document.createElement("div");
  summary.className = "truesight-tooltip-summary";
  summary.textContent = claim.summary;
  tip.appendChild(summary);

  const action = document.createElement("div");
  action.className = "truesight-tooltip-action";
  action.textContent = "Click for details";
  tip.appendChild(action);

  document.body.appendChild(tip);
  positionTooltip(tip, anchor);
  tip.style.visibility = "visible";

  return tip;
}

function applyThemeClass(element: HTMLElement, theme: ThemeMode): void {
  element.classList.remove("truesight-theme-light", "truesight-theme-dark");
  element.classList.add(`truesight-theme-${theme}`);
}

function parseCssColor(value: string): [number, number, number, number] | null {
  const rgbaMatch = value.match(
    /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})(?:\s*,\s*([0-9]*\.?[0-9]+))?\s*\)$/i,
  );
  if (!rgbaMatch) return null;

  const red = Number.parseInt(rgbaMatch[1] ?? "", 10);
  const green = Number.parseInt(rgbaMatch[2] ?? "", 10);
  const blue = Number.parseInt(rgbaMatch[3] ?? "", 10);
  const alpha = rgbaMatch[4] === undefined ? 1 : Number.parseFloat(rgbaMatch[4]);

  if (
    Number.isNaN(red) ||
    Number.isNaN(green) ||
    Number.isNaN(blue) ||
    Number.isNaN(alpha)
  ) {
    return null;
  }

  return [red, green, blue, alpha];
}

function relativeLuminance(red: number, green: number, blue: number): number {
  const normalize = (channel: number): number => {
    const srgb = channel / 255;
    if (srgb <= 0.03928) return srgb / 12.92;
    return ((srgb + 0.055) / 1.055) ** 2.4;
  };

  const r = normalize(red);
  const g = normalize(green);
  const b = normalize(blue);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function findNearestOpaqueBackgroundLuminance(
  anchor: HTMLElement | null,
): number | null {
  let element: HTMLElement | null = anchor;
  while (element) {
    const parsed = parseCssColor(getComputedStyle(element).backgroundColor);
    if (parsed && parsed[3] > 0.05) {
      return relativeLuminance(parsed[0], parsed[1], parsed[2]);
    }
    element = element.parentElement;
  }

  const bodyParsed = parseCssColor(getComputedStyle(document.body).backgroundColor);
  if (bodyParsed && bodyParsed[3] > 0.05) {
    return relativeLuminance(bodyParsed[0], bodyParsed[1], bodyParsed[2]);
  }

  const htmlParsed = parseCssColor(getComputedStyle(document.documentElement).backgroundColor);
  if (htmlParsed && htmlParsed[3] > 0.05) {
    return relativeLuminance(htmlParsed[0], htmlParsed[1], htmlParsed[2]);
  }

  return null;
}

function detectThemeFromAnchor(anchor: HTMLElement | null): ThemeMode {
  const luminance = findNearestOpaqueBackgroundLuminance(anchor);
  if (luminance !== null) {
    return luminance < 0.4 ? "dark" : "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function positionTooltip(tip: HTMLDivElement, anchor: HTMLElement): void {
  const anchorRect = anchor.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;

  const maxWidth = Math.min(
    TOOLTIP_MAX_WIDTH_PX,
    Math.max(TOOLTIP_MIN_WIDTH_PX, viewportWidth - TOOLTIP_MARGIN_PX * 2),
  );
  const preferredWidth = clamp(
    Math.max(anchorRect.width, Math.min(420, maxWidth)),
    TOOLTIP_MIN_WIDTH_PX,
    maxWidth,
  );

  tip.style.width = `${preferredWidth.toString()}px`;
  tip.style.maxWidth = `${maxWidth.toString()}px`;

  const tipRect = tip.getBoundingClientRect();
  const spaceAbove = anchorRect.top - TOOLTIP_MARGIN_PX;
  const spaceBelow = viewportHeight - anchorRect.bottom - TOOLTIP_MARGIN_PX;
  const fitsAbove = spaceAbove >= tipRect.height + TOOLTIP_GAP_PX;
  const fitsBelow = spaceBelow >= tipRect.height + TOOLTIP_GAP_PX;
  const placeAbove = fitsAbove && (!fitsBelow || spaceAbove >= spaceBelow);

  const unclampedTop = placeAbove
    ? anchorRect.top - tipRect.height - TOOLTIP_GAP_PX
    : anchorRect.bottom + TOOLTIP_GAP_PX;
  const unclampedLeft = anchorRect.left;

  const top = clamp(
    unclampedTop,
    TOOLTIP_MARGIN_PX,
    Math.max(TOOLTIP_MARGIN_PX, viewportHeight - tipRect.height - TOOLTIP_MARGIN_PX),
  );
  const left = clamp(
    unclampedLeft,
    TOOLTIP_MARGIN_PX,
    Math.max(TOOLTIP_MARGIN_PX, viewportWidth - tipRect.width - TOOLTIP_MARGIN_PX),
  );

  tip.style.top = `${Math.round(top).toString()}px`;
  tip.style.left = `${Math.round(left).toString()}px`;
}

/**
 * Fallback for cross-element ranges: extract the text nodes covered by
 * the range and wrap each individually.
 */
function highlightFragments(
  range: Range,
  claim: InvestigationClaim,
): void {
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT,
  );

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (range.intersectsNode(node)) {
      textNodes.push(node);
    }
  }

  for (const textNode of textNodes) {
    const nodeRange = document.createRange();

    // Clamp to the portion of this text node that falls within the range
    if (textNode === range.startContainer) {
      nodeRange.setStart(textNode, range.startOffset);
    } else {
      nodeRange.setStart(textNode, 0);
    }

    if (textNode === range.endContainer) {
      nodeRange.setEnd(textNode, range.endOffset);
    } else {
      nodeRange.setEnd(textNode, textNode.length);
    }

    if (nodeRange.toString().length === 0) continue;

    try {
      const mark = createMarkElement(claim);
      nodeRange.surroundContents(mark);
      attachInteractions(mark, claim);
    } catch {
      // If individual wrapping still fails, skip this fragment
    }
  }
}
