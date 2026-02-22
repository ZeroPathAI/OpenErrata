type PageObserverConfig = {
  mutationDebounceMs: number;
  onNavigation: () => void;
  onMutationSettled: () => void;
};

export class PageObserver {
  readonly #config: PageObserverConfig;
  #mutationObserver: MutationObserver | null = null;
  #mutationDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #restorePushState: (() => void) | null = null;
  #restoreReplaceState: (() => void) | null = null;
  #popstateListener: (() => void) | null = null;

  constructor(config: PageObserverConfig) {
    this.#config = config;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;

    this.#installNavigationListeners();
    this.#startMutationObserver();
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

    this.#restorePushState?.();
    this.#restorePushState = null;
    this.#restoreReplaceState?.();
    this.#restoreReplaceState = null;

    if (this.#popstateListener) {
      window.removeEventListener("popstate", this.#popstateListener);
      this.#popstateListener = null;
    }
  }

  #installNavigationListeners(): void {
    const originalPushState = history.pushState.bind(history);
    history.pushState = (...args: Parameters<History["pushState"]>) => {
      originalPushState(...args);
      this.#config.onNavigation();
    };
    this.#restorePushState = () => {
      history.pushState = originalPushState;
    };

    const originalReplaceState = history.replaceState.bind(history);
    history.replaceState = (...args: Parameters<History["replaceState"]>) => {
      originalReplaceState(...args);
      this.#config.onNavigation();
    };
    this.#restoreReplaceState = () => {
      history.replaceState = originalReplaceState;
    };

    this.#popstateListener = () => {
      this.#config.onNavigation();
    };
    window.addEventListener("popstate", this.#popstateListener);
  }

  #startMutationObserver(): void {
    this.#mutationObserver = new MutationObserver(() => {
      if (this.#mutationDebounceTimer !== null) {
        clearTimeout(this.#mutationDebounceTimer);
      }

      this.#mutationDebounceTimer = setTimeout(() => {
        this.#config.onMutationSettled();
      }, this.#config.mutationDebounceMs);
    });

    this.#mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }
}
