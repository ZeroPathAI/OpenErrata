interface PageObserverConfig {
  mutationDebounceMs: number;
  /** Back/forward navigation within the document. */
  onPopState: () => void;
  onMutationSettled: () => void;
}

/**
 * DOM-side signals of page change. History API navigations (`pushState` /
 * `replaceState`) happen in the page's world, invisible to this isolated
 * content script; the background relays them as `LOCATION_CHANGED`.
 */
export class PageObserver {
  readonly #config: PageObserverConfig;
  #mutationObserver: MutationObserver | null = null;
  #mutationDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  readonly #onPopState = (): void => {
    this.#config.onPopState();
  };

  constructor(config: PageObserverConfig) {
    this.#config = config;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;

    window.addEventListener("popstate", this.#onPopState);
    this.#mutationObserver = new MutationObserver(() => {
      if (this.#mutationDebounceTimer !== null) {
        clearTimeout(this.#mutationDebounceTimer);
      }
      this.#mutationDebounceTimer = setTimeout(() => {
        this.#mutationDebounceTimer = null;
        this.#config.onMutationSettled();
      }, this.#config.mutationDebounceMs);
    });
    this.#mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;

    if (this.#mutationDebounceTimer !== null) {
      clearTimeout(this.#mutationDebounceTimer);
      this.#mutationDebounceTimer = null;
    }
    this.#mutationObserver?.disconnect();
    this.#mutationObserver = null;
    window.removeEventListener("popstate", this.#onPopState);
  }
}
