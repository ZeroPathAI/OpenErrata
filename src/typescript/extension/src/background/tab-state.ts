import {
  extensionPageStatusSchema,
  type ExtensionPageStatus,
  type TabSessionId,
} from "@openerrata/shared";
import { tabStatusStorageKey } from "../lib/storage-keys.js";

interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

interface TabStateDeps {
  /** `storage.session`: survives service-worker restarts, not browser restarts. */
  storage: SessionStorageArea;
  /** Push a newly cached status to the tab's content script. */
  notifyTab: (tabId: number, status: ExtensionPageStatus) => Promise<void>;
  updateBadge: (tabId: number, status: ExtensionPageStatus | null) => void;
  listTabIds: () => Promise<number[]>;
}

/**
 * A tab's page sessions as the background has seen them. Session ids are
 * random, so recency is arrival order: the first message from a new session
 * makes it current and retires the previous one, and a retired session can
 * never become current again — late replies for it are dropped.
 */
interface TabSessions {
  current: TabSessionId | null;
  retired: Set<TabSessionId>;
}

/**
 * Per-tab state of the background: which page session is current, and the
 * status cached for it (spec §3.8.1). Statuses live in memory with
 * write-through to `storage.session`; each write is pushed to the tab's
 * content script and reflected in the toolbar badge.
 */
export class TabStates {
  readonly #deps: TabStateDeps;
  readonly #sessions = new Map<number, TabSessions>();
  readonly #statuses = new Map<number, ExtensionPageStatus | null>();
  readonly #loads = new Map<number, Promise<void>>();
  readonly #writes = new Map<number, Promise<void>>();

  constructor(deps: TabStateDeps) {
    this.#deps = deps;
  }

  /**
   * Note a message from page session `sessionId`. Returns false when that
   * session was already superseded, i.e. the message is stale.
   */
  claimSession(tabId: number, sessionId: TabSessionId): boolean {
    const sessions = this.#sessions.get(tabId) ?? { current: null, retired: new Set() };
    this.#sessions.set(tabId, sessions);
    if (sessions.retired.has(sessionId)) return false;
    if (sessions.current !== null && sessions.current !== sessionId) {
      sessions.retired.add(sessions.current);
    }
    sessions.current = sessionId;
    return true;
  }

  /** The page session ended; its cached status (if still the tab's) is discarded. */
  async retireSession(tabId: number, sessionId: TabSessionId): Promise<void> {
    const sessions = this.#sessions.get(tabId) ?? { current: null, retired: new Set() };
    this.#sessions.set(tabId, sessions);
    sessions.retired.add(sessionId);
    if (sessions.current === sessionId) {
      sessions.current = null;
    }

    await this.#load(tabId);
    if (this.#statuses.get(tabId)?.tabSessionId === sessionId) {
      await this.#write(tabId, null);
    }
  }

  /** The tab loaded a new document or closed: forget everything about it. */
  async forgetTab(tabId: number): Promise<void> {
    this.#sessions.delete(tabId);
    await this.#write(tabId, null);
  }

  async getStatus(tabId: number): Promise<ExtensionPageStatus | null> {
    await this.#load(tabId);
    return this.#statuses.get(tabId) ?? null;
  }

  /**
   * Cache `status` for its page session. Returns false (and writes nothing)
   * when that session is no longer the tab's current one.
   */
  async putStatus(tabId: number, status: ExtensionPageStatus): Promise<boolean> {
    await this.#load(tabId);
    if (!this.#isCurrentSession(tabId, status.tabSessionId)) {
      return false;
    }
    await this.#write(tabId, status);
    void this.#deps.notifyTab(tabId, status).catch((error: unknown) => {
      console.error(`Failed to push status to content script of tab ${tabId.toString()}:`, error);
    });
    return true;
  }

  async syncBadges(): Promise<void> {
    const tabIds = await this.#deps.listTabIds();
    await Promise.all(
      tabIds.map(async (tabId) => {
        this.#deps.updateBadge(tabId, await this.getStatus(tabId));
      }),
    );
  }

  #isCurrentSession(tabId: number, sessionId: TabSessionId): boolean {
    const sessions = this.#sessions.get(tabId);
    if (sessions !== undefined) {
      return sessions.current === sessionId;
    }
    // No message seen since this worker started: the cached status's session
    // is the latest one the background knows of.
    return this.#statuses.get(tabId)?.tabSessionId === sessionId;
  }

  async #load(tabId: number): Promise<void> {
    if (this.#statuses.has(tabId)) return;
    let load = this.#loads.get(tabId);
    if (load === undefined) {
      load = (async () => {
        const key = tabStatusStorageKey(tabId);
        const record = await this.#deps.storage.get(key);
        const stored = record[key];
        if (!this.#statuses.has(tabId)) {
          this.#statuses.set(
            tabId,
            stored === undefined ? null : extensionPageStatusSchema.parse(stored),
          );
        }
      })().finally(() => {
        this.#loads.delete(tabId);
      });
      this.#loads.set(tabId, load);
    }
    await load;
  }

  async #write(tabId: number, status: ExtensionPageStatus | null): Promise<void> {
    this.#statuses.set(tabId, status);
    this.#deps.updateBadge(tabId, status);
    // Persist in call order; each write stores the latest in-memory value, so
    // completion order cannot leave an older status in storage.
    const previous = this.#writes.get(tabId) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        const key = tabStatusStorageKey(tabId);
        const latest = this.#statuses.get(tabId) ?? null;
        if (latest === null) {
          await this.#deps.storage.remove(key);
        } else {
          await this.#deps.storage.set({ [key]: latest });
        }
      });
    this.#writes.set(tabId, write);
    await write;
  }
}
