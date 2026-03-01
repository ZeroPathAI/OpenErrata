import type { InvestigationClaim } from "@openerrata/shared";
import { renderAnnotations, clearAnnotations } from "./annotator";
import type { PlatformAdapter } from "./adapters/index";
import { mapClaimsToDom } from "./dom-mapper";
import { ANNOTATION_SELECTOR } from "./annotation-dom";

export class AnnotationController {
  #visible = true;
  #claims: InvestigationClaim[] = [];

  isVisible(): boolean {
    return this.#visible;
  }

  getClaims(): InvestigationClaim[] {
    return this.#claims;
  }

  setClaims(claims: InvestigationClaim[]): void {
    this.#claims = claims;
  }

  clearAll(): void {
    this.#claims = [];
    clearAnnotations();
  }

  show(adapter: PlatformAdapter | null): void {
    this.#visible = true;
    if (!adapter) return;
    this.render(adapter);
  }

  hide(): void {
    this.#visible = false;
    clearAnnotations();
  }

  render(adapter: PlatformAdapter): boolean {
    if (!this.#visible || this.#claims.length === 0) {
      clearAnnotations();
      return true;
    }

    const root = adapter.getContentRoot(document);
    if (!root) return false;

    clearAnnotations();
    const annotations = mapClaimsToDom(this.#claims, root);
    renderAnnotations(annotations);
    return true;
  }

  reapplyIfMissing(adapter: PlatformAdapter): void {
    if (!this.#visible || this.#claims.length === 0) return;

    const root = adapter.getContentRoot(document);
    if (!root) return;
    if (root.querySelector(ANNOTATION_SELECTOR)) return;
    this.render(adapter);
  }
}
