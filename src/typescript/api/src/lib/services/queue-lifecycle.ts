// ── Queue lifecycle state machine ────────────────────────────────────────
//
// Manages a lazily-initialized, closeable resource pool. The state machine
// ensures that initialization, usage, and shutdown are properly serialized
// even under concurrent access.
//
// Transitions:
//   idle         → initializing   acquire starts connection
//   idle         → closed         close requested with nothing to release
//   initializing → ready          connection succeeds
//   initializing → idle           connection fails (retry allowed)
//   initializing → closing        close requested during connection
//   ready        → closing        close requested
//   closing      → closed         release succeeds
//   closing      → idle           release fails (retry allowed)
//   closed       → (terminal)     acquire throws

export interface Releasable {
  release(): void | Promise<void>;
}

export const QUEUE_ERROR_CODES = {
  CLOSED: "QUEUE_CLOSED",
  CONNECT_FAILED: "QUEUE_CONNECT_FAILED",
  RELEASE_FAILED: "QUEUE_RELEASE_FAILED",
} as const;

export type QueueErrorCode = (typeof QUEUE_ERROR_CODES)[keyof typeof QUEUE_ERROR_CODES];

class QueueLifecycleError extends Error {
  constructor(
    readonly code: QueueErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class QueueClosedError extends QueueLifecycleError {
  constructor() {
    super(QUEUE_ERROR_CODES.CLOSED, "Queue utilities are closed");
  }
}

export class QueueConnectError extends QueueLifecycleError {
  constructor(cause: unknown) {
    super(QUEUE_ERROR_CODES.CONNECT_FAILED, "Queue utilities failed to initialize", { cause });
  }
}

export class QueueReleaseError extends QueueLifecycleError {
  constructor(cause: unknown) {
    super(QUEUE_ERROR_CODES.RELEASE_FAILED, "Queue utilities failed to release", { cause });
  }
}

interface QueueManager<T> {
  acquire(): Promise<T>;
  close(): Promise<void>;
}

type QueueState<T> =
  | { phase: "idle" }
  | { phase: "initializing"; promise: Promise<T> }
  | { phase: "ready"; utils: T }
  | { phase: "closing"; promise: Promise<void> }
  | { phase: "closed" };

export function createQueueManager<T extends Releasable>(
  connect: () => Promise<T>,
): QueueManager<T> {
  let state: QueueState<T> = { phase: "idle" };

  /**
   * Checks whether the given promise is still the active initialization
   * attempt. State can change across await boundaries (e.g. close requested
   * during init), so callers must re-check after any suspension. This is
   * extracted as a function so TypeScript reads `state` without the enclosing
   * switch-case narrowing that would make the check look redundant to the
   * linter.
   */
  function isActiveInit(promise: Promise<T>): boolean {
    return state.phase === "initializing" && state.promise === promise;
  }

  async function acquire(): Promise<T> {
    while (true) {
      switch (state.phase) {
        case "closed":
          throw new QueueClosedError();

        case "closing":
          // Wait for close to finish, then re-check. Swallow close errors —
          // an acquire caller should not see release failures.
          try {
            await state.promise;
          } catch {
            // Close failed; state is now idle. Loop will retry initialization.
          }
          continue;

        case "ready":
          return state.utils;

        case "idle": {
          const promise = connect();
          state = { phase: "initializing", promise };
          continue;
        }

        case "initializing": {
          const { promise } = state;
          let utils: T;
          try {
            utils = await promise;
          } catch (error) {
            if (isActiveInit(promise)) {
              state = { phase: "idle" };
              throw new QueueConnectError(error);
            }
            // State changed during init (e.g. close was requested).
            // Swallow the connection error and re-check — callers should
            // see "closed", not a transient connection failure.
            continue;
          }
          if (isActiveInit(promise)) {
            state = { phase: "ready", utils };
            return utils;
          }
          // State changed during init (e.g. close was requested). Re-check.
          continue;
        }
      }
    }
  }

  async function releaseAndClose(utils: T): Promise<void> {
    try {
      await utils.release();
      state = { phase: "closed" };
    } catch (error) {
      // Release failed — revert to idle so close can be retried.
      state = { phase: "idle" };
      throw new QueueReleaseError(error);
    }
  }

  async function awaitInitThenClose(initPromise: Promise<T>): Promise<void> {
    let utils: T;
    try {
      utils = await initPromise;
    } catch {
      // Init failed — nothing to release. Close succeeds.
      state = { phase: "closed" };
      return;
    }
    await releaseAndClose(utils);
  }

  async function close(): Promise<void> {
    switch (state.phase) {
      case "closed":
        return;

      case "closing":
        await state.promise;
        return;

      case "idle": {
        state = { phase: "closed" };
        return;
      }

      case "ready": {
        const { utils } = state;
        const promise = releaseAndClose(utils);
        state = { phase: "closing", promise };
        await promise;
        return;
      }

      case "initializing": {
        const { promise: initPromise } = state;
        const promise = awaitInitThenClose(initPromise);
        state = { phase: "closing", promise };
        await promise;
        return;
      }
    }
  }

  return { acquire, close };
}
