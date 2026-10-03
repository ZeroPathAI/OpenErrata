import type { InvestigationClaim } from "@openerrata/shared";
import type { DomAnnotation } from "./dom-mapper";
import type { DomTextPiece } from "./dom-text-index";
import { renderClaimReasoningHtml, toSafeSourceUrl } from "./claim-markdown";
import {
  ANNOTATION_CLAIM_ID_ATTRIBUTE,
  ANNOTATION_CLASS,
  unwrapAnnotationMarks,
} from "./annotation-dom";

const TOOLTIP_MARGIN_PX = 12;
const TOOLTIP_GAP_PX = 8;
const TOOLTIP_MIN_WIDTH_PX = 260;
const TOOLTIP_MAX_WIDTH_PX = 680;
type ThemeMode = "light" | "dark";
let activeDetailPanel: HTMLDivElement | null = null;
let activeDetailPanelBackdrop: HTMLDivElement | null = null;
let disposeActiveDetailPanel: (() => void) | null = null;

function dismissDetailPanel(): void {
  disposeActiveDetailPanel?.();
  disposeActiveDetailPanel = null;
  if (activeDetailPanel?.isConnected) {
    activeDetailPanel.remove();
  }
  activeDetailPanel = null;
  if (activeDetailPanelBackdrop?.isConnected) {
    activeDetailPanelBackdrop.remove();
  }
  activeDetailPanelBackdrop = null;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * One highlighted text-node piece and how to undo it. Pages like X and
 * LessWrong are React apps that keep references to their text nodes, so a
 * highlight must leave the page's own node (`original`) in place and, when
 * removed, merge back exactly the nodes our wrapping split off it — never
 * `normalize()` neighbouring text nodes the page owns.
 */
export interface WrappedPiece {
  mark: HTMLElement;
  /** The page's text node; it keeps the text before the highlight (or is the highlighted node). */
  original: Text;
  /** The highlighted text, inside `mark`. Equal to `original` when the highlight starts at offset 0. */
  wrapped: Text;
  /** Text split off after the highlight, if any. */
  trailing: Text | null;
}

/**
 * Wrap every matched claim piece in a highlight mark with tooltip / click
 * behaviour. Returns the wrapped pieces in wrapping order (for `unwrapPieces`).
 * Pieces of one text node are wrapped back to front so earlier offsets stay
 * valid; a piece overlapping one already wrapped (two claims quoting the same
 * text) is skipped.
 */
export function wrapAnnotations(annotations: readonly DomAnnotation[]): WrappedPiece[] {
  const piecesByNode = new Map<Text, { piece: DomTextPiece; claim: InvestigationClaim }[]>();
  for (const annotation of annotations) {
    if (!annotation.matched) continue;
    for (const piece of annotation.pieces) {
      const nodePieces = piecesByNode.get(piece.node) ?? [];
      nodePieces.push({ piece, claim: annotation.claim });
      piecesByNode.set(piece.node, nodePieces);
    }
  }

  const wrapped: WrappedPiece[] = [];
  for (const [node, nodePieces] of piecesByNode) {
    nodePieces.sort((left, right) => right.piece.start - left.piece.start);
    let wrappedFrom = node.length;
    for (const { piece, claim } of nodePieces) {
      if (piece.end > wrappedFrom) continue;
      wrapped.push(wrapPiece(node, piece.start, piece.end, claim));
      wrappedFrom = piece.start;
    }
  }
  return wrapped;
}

/** Undo `wrapAnnotations`, restoring the page's text nodes. */
export function unwrapPieces(pieces: readonly WrappedPiece[]): void {
  for (const piece of [...pieces].reverse()) {
    piece.mark.replaceWith(piece.wrapped);
    if (piece.wrapped !== piece.original && piece.wrapped.previousSibling === piece.original) {
      piece.original.appendData(piece.wrapped.data);
      piece.wrapped.remove();
    }
    if (piece.trailing?.previousSibling === piece.original) {
      piece.original.appendData(piece.trailing.data);
      piece.trailing.remove();
    }
  }
}

/** Remove highlight marks this controller does not track (e.g. left by an orphaned script). */
export function unwrapUntrackedMarks(): void {
  unwrapAnnotationMarks(document);
}

/** Close any open tooltip or detail panel. */
export function dismissAnnotationOverlays(): void {
  dismissDetailPanel();
  document
    .querySelectorAll(
      ".openerrata-tooltip, .openerrata-detail-panel, .openerrata-detail-panel-backdrop",
    )
    .forEach((el) => {
      el.remove();
    });
}

/**
 * Show a slide-in detail panel with the full explanation and source links
 * for a single claim.
 */
function showDetailPanel(claim: InvestigationClaim, anchor: HTMLElement | null = null): void {
  dismissDetailPanel();

  const backdrop = document.createElement("div");
  backdrop.className = "openerrata-detail-panel-backdrop";

  const panel = document.createElement("div");
  panel.className = "openerrata-detail-panel";
  applyThemeClass(panel, detectThemeFromAnchor(anchor));

  const closeBtn = document.createElement("button");
  closeBtn.className = "close-btn";
  closeBtn.textContent = "\u00d7"; // ×
  panel.appendChild(closeBtn);

  const heading = document.createElement("h3");
  heading.textContent = "OpenErrata — Claim Details";
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
  reasoningBody.innerHTML = renderClaimReasoningHtml(claim.reasoning);
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
      if (safeUrl !== null) {
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

      if (source.snippet.length > 0) {
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

  const closePanel = () => {
    if (activeDetailPanel === panel) {
      dismissDetailPanel();
      return;
    }
    if (panel.isConnected) {
      panel.remove();
    }
    if (backdrop.isConnected) {
      backdrop.remove();
    }
  };

  const onBackdropPointerDown = (event: PointerEvent) => {
    if (event.target !== backdrop) return;
    closePanel();
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closePanel();
    }
  };
  const onDetached = new MutationObserver(() => {
    if (!panel.isConnected || !backdrop.isConnected) {
      if (activeDetailPanel === panel) {
        dismissDetailPanel();
        return;
      }
      document.removeEventListener("keydown", onKey);
      backdrop.removeEventListener("pointerdown", onBackdropPointerDown);
      onDetached.disconnect();
    }
  });
  onDetached.observe(document.body, { childList: true, subtree: true });

  backdrop.addEventListener("pointerdown", onBackdropPointerDown);
  closeBtn.addEventListener("click", closePanel);
  disposeActiveDetailPanel = () => {
    document.removeEventListener("keydown", onKey);
    backdrop.removeEventListener("pointerdown", onBackdropPointerDown);
    onDetached.disconnect();
  };
  activeDetailPanel = panel;
  activeDetailPanelBackdrop = backdrop;

  document.addEventListener("keydown", onKey);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
}
// ── Internal helpers ──────────────────────────────────────────────────────

function wrapPiece(
  node: Text,
  start: number,
  end: number,
  claim: InvestigationClaim,
): WrappedPiece {
  const trailing = end < node.length ? node.splitText(end) : null;
  const wrapped = start > 0 ? node.splitText(start) : node;
  const mark = createMarkElement(claim);
  wrapped.before(mark);
  mark.appendChild(wrapped);
  attachInteractions(mark, claim);
  return { mark, original: node, wrapped, trailing };
}

function createMarkElement(claim: InvestigationClaim): HTMLElement {
  const mark = document.createElement("mark");
  mark.className = ANNOTATION_CLASS;
  mark.setAttribute(ANNOTATION_CLAIM_ID_ATTRIBUTE, claim.id);
  mark.setAttribute("aria-label", `OpenErrata claim highlight: ${claim.summary}`);
  return mark;
}

function attachInteractions(mark: HTMLElement, claim: InvestigationClaim): void {
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

function createTooltip(claim: InvestigationClaim, anchor: HTMLElement): HTMLDivElement {
  // Remove any stale tooltips
  document.querySelectorAll(".openerrata-tooltip").forEach((el) => el.remove());

  const tip = document.createElement("div");
  tip.className = "openerrata-tooltip";
  applyThemeClass(tip, detectThemeFromAnchor(anchor));
  tip.style.visibility = "hidden";

  const summary = document.createElement("div");
  summary.className = "openerrata-tooltip-summary";
  summary.textContent = claim.summary;
  tip.appendChild(summary);

  const action = document.createElement("div");
  action.className = "openerrata-tooltip-action";
  action.textContent = "Click for details";
  tip.appendChild(action);

  document.body.appendChild(tip);
  positionTooltip(tip, anchor);
  tip.style.visibility = "visible";

  return tip;
}

function applyThemeClass(element: HTMLElement, theme: ThemeMode): void {
  element.classList.remove("openerrata-theme-light", "openerrata-theme-dark");
  element.classList.add(`openerrata-theme-${theme}`);
}

function parseCssColor(value: string): [number, number, number, number] | null {
  const rgbaMatch =
    /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})(?:\s*,\s*([0-9]*\.?[0-9]+))?\s*\)$/i.exec(
      value,
    );
  if (!rgbaMatch) return null;

  const red = Number.parseInt(rgbaMatch[1] ?? "", 10);
  const green = Number.parseInt(rgbaMatch[2] ?? "", 10);
  const blue = Number.parseInt(rgbaMatch[3] ?? "", 10);
  const alpha = rgbaMatch[4] === undefined ? 1 : Number.parseFloat(rgbaMatch[4]);

  if (Number.isNaN(red) || Number.isNaN(green) || Number.isNaN(blue) || Number.isNaN(alpha)) {
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

function findNearestOpaqueBackgroundLuminance(anchor: HTMLElement | null): number | null {
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

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
