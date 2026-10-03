import type { InvestigationClaim } from "@openerrata/shared";
import type { PlatformAdapter } from "./adapters/index";
import { ANNOTATION_CLAIM_ID_ATTRIBUTE } from "./annotation-dom";
import {
  dismissAnnotationOverlays,
  unwrapPieces,
  unwrapUntrackedMarks,
  wrapAnnotations,
  type WrappedPiece,
} from "./annotator";
import { areClaimsEqual } from "./annotation-lifecycle";
import { contentTextIndexOf } from "./content-text";
import { mapClaimsToDom } from "./dom-mapper";
import type { DomTextPiece } from "./dom-text-index";

/** The claims highlighted on the page, and whether highlights are shown. */
export class AnnotationController {
  #visible = true;
  #claims: InvestigationClaim[] = [];
  #rendered: WrappedPiece[] = [];

  isVisible(): boolean {
    return this.#visible;
  }

  getClaims(): InvestigationClaim[] {
    return this.#claims;
  }

  /** Highlight `claims` in the adapter's content root (re-rendering only when they changed). */
  showClaims(claims: InvestigationClaim[], adapter: PlatformAdapter): boolean {
    if (areClaimsEqual(this.#claims, claims)) {
      this.reapplyIfMissing(adapter);
      return true;
    }
    this.#claims = claims;
    return this.render(adapter);
  }

  clearAll(): void {
    this.#claims = [];
    this.#unrender();
  }

  show(adapter: PlatformAdapter | null): void {
    this.#visible = true;
    if (!adapter) return;
    this.render(adapter);
  }

  hide(): void {
    this.#visible = false;
    this.#unrender();
  }

  /** Re-render all highlights; false when the content root is not in the DOM. */
  render(adapter: PlatformAdapter): boolean {
    this.#unrender();
    if (!this.#visible || this.#claims.length === 0) {
      return true;
    }

    // Highlights are removed first so the text index sees the page's own nodes.
    const textIndex = contentTextIndexOf(adapter, document);
    if (textIndex === null) return false;
    this.#rendered = wrapAnnotations(mapClaimsToDom(this.#claims, textIndex));
    return true;
  }

  /** Re-render when the page threw our highlights away (e.g. a React re-render). */
  reapplyIfMissing(adapter: PlatformAdapter): void {
    if (!this.#visible || this.#claims.length === 0) return;
    if (this.#rendered.some((piece) => piece.mark.isConnected)) return;
    this.render(adapter);
  }

  /** The first rendered highlight of a claim, if it is on the page. */
  renderedAnchorFor(claimId: string): HTMLElement | null {
    return (
      this.#rendered.find(
        (piece) =>
          piece.mark.isConnected &&
          piece.mark.getAttribute(ANNOTATION_CLAIM_ID_ATTRIBUTE) === claimId,
      )?.mark ?? null
    );
  }

  /** Where a claim is in the page right now, matched with high confidence only. */
  locateClaim(claim: InvestigationClaim, adapter: PlatformAdapter): DomTextPiece[] | null {
    const textIndex = contentTextIndexOf(adapter, document);
    if (textIndex === null) return null;
    const [annotation] = mapClaimsToDom([claim], textIndex, { allowFuzzy: false });
    return annotation?.matched === true ? annotation.pieces : null;
  }

  #unrender(): void {
    unwrapPieces(this.#rendered);
    this.#rendered = [];
    unwrapUntrackedMarks();
    dismissAnnotationOverlays();
  }
}
