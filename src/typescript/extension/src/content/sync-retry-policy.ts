import type { ExtensionRuntimeErrorCode } from "@openerrata/shared";
import { ExtensionRuntimeError, isExtensionContextInvalidatedError } from "../lib/runtime-error.js";

/** Retry schedule for a page session whose sync with the background failed. */
export type SyncRetryState =
  | { kind: "NONE" }
  | { kind: "SCHEDULED"; sessionKey: string; attempt: number };

export const NO_SYNC_RETRY: SyncRetryState = { kind: "NONE" };

export function hasPendingRetryForSession(
  retryState: SyncRetryState,
  sessionKey: string | null,
): boolean {
  return retryState.kind === "SCHEDULED" && retryState.sessionKey === sessionKey;
}

/** Exponential backoff: `initialDelayMs * 2^attempt`, capped at `maxDelayMs`. */
export function scheduleSyncRetry(
  retryState: SyncRetryState,
  sessionKey: string,
  delays: { initialDelayMs: number; maxDelayMs: number },
): { nextState: SyncRetryState; delayMs: number } {
  const attempt =
    retryState.kind === "SCHEDULED" && retryState.sessionKey === sessionKey
      ? retryState.attempt + 1
      : 0;
  return {
    delayMs: Math.min(delays.initialDelayMs * 2 ** attempt, delays.maxDelayMs),
    nextState: { kind: "SCHEDULED", sessionKey, attempt },
  };
}

/**
 * Failures retrying cannot fix: the request itself is unacceptable, or the
 * extension's version or settings are. The background has already cached an
 * API_ERROR status for the session.
 */
const NON_RETRYABLE_ERROR_CODES: ReadonlySet<ExtensionRuntimeErrorCode> = new Set([
  "PAYLOAD_TOO_LARGE",
  "UPGRADE_REQUIRED",
  "MALFORMED_EXTENSION_VERSION",
  "INVALID_EXTENSION_MESSAGE",
  "INVALID_EXTENSION_SETTINGS",
]);

type SyncFailureAction =
  /** The extension was reloaded or removed; this content script is orphaned. */
  { kind: "SHUT_DOWN" } | { kind: "GIVE_UP" } | { kind: "RETRY" };

export function syncFailureAction(error: unknown): SyncFailureAction {
  if (isExtensionContextInvalidatedError(error)) {
    return { kind: "SHUT_DOWN" };
  }
  if (
    error instanceof ExtensionRuntimeError &&
    error.errorCode !== undefined &&
    NON_RETRYABLE_ERROR_CODES.has(error.errorCode)
  ) {
    return { kind: "GIVE_UP" };
  }
  return { kind: "RETRY" };
}
