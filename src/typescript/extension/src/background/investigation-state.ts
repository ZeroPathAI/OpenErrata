export type InvestigationPoller = {
  tabSessionId: number;
  investigationId: string;
  inFlight: boolean;
  timer: ReturnType<typeof setInterval> | null;
};

export class BackgroundInvestigationState {
  private readonly latestTabSessionByTab = new Map<number, number>();
  private readonly investigationPollers = new Map<number, InvestigationPoller>();

  noteTabSession(tabId: number, tabSessionId: number): void {
    const existing = this.latestTabSessionByTab.get(tabId);
    if (existing === undefined || tabSessionId > existing) {
      this.latestTabSessionByTab.set(tabId, tabSessionId);
    }
  }

  retireTabSession(tabId: number, tabSessionId: number): void {
    this.noteTabSession(tabId, tabSessionId + 1);
  }

  clearTabSession(tabId: number): void {
    this.latestTabSessionByTab.delete(tabId);
  }

  isStaleTabSession(tabId: number, tabSessionId: number): boolean {
    const latest = this.latestTabSessionByTab.get(tabId);
    if (latest === undefined) return false;
    return tabSessionId < latest;
  }

  setPoller(tabId: number, poller: InvestigationPoller): void {
    this.investigationPollers.set(tabId, poller);
  }

  getPoller(tabId: number): InvestigationPoller | undefined {
    return this.investigationPollers.get(tabId);
  }

  clearPoller(tabId: number): void {
    this.investigationPollers.delete(tabId);
  }

  pollerTabIds(): IterableIterator<number> {
    return this.investigationPollers.keys();
  }
}
