export interface SyncRetryState {
  pendingSessionKey: string | null;
  nextDelayMs: number;
}

export type SyncTrackedSnapshotErrorPolicy =
  | {
      matches: (error: unknown) => boolean;
      action: "RESET_AND_SYNC_CACHED_FAILURE";
      warningMessage: string;
    }
  | {
      matches: (error: unknown) => boolean;
      action: "RESET_ONLY";
    };

export function createInitialSyncRetryState(initialDelayMs: number): SyncRetryState {
  return {
    pendingSessionKey: null,
    nextDelayMs: initialDelayMs,
  };
}

export function hasPendingRetryForSession(
  retryState: SyncRetryState,
  sessionKey: string | null,
): boolean {
  return sessionKey !== null && retryState.pendingSessionKey === sessionKey;
}

export function scheduleSyncRetry(
  retryState: SyncRetryState,
  sessionKey: string,
  maxDelayMs: number,
): { nextState: SyncRetryState; delayMs: number } {
  const delayMs = retryState.nextDelayMs;
  return {
    delayMs,
    nextState: {
      pendingSessionKey: sessionKey,
      nextDelayMs: Math.min(retryState.nextDelayMs * 2, maxDelayMs),
    },
  };
}

export function resolveSyncTrackedSnapshotErrorPolicy(
  error: unknown,
  policies: readonly SyncTrackedSnapshotErrorPolicy[],
): SyncTrackedSnapshotErrorPolicy | null {
  return policies.find((candidate) => candidate.matches(error)) ?? null;
}
