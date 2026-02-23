import assert from "node:assert/strict";
import { test } from "node:test";
import {
  QUEUE_ERROR_CODES,
  QueueClosedError,
  QueueConnectError,
  QueueReleaseError,
  createQueueManager,
  type QueueErrorCode,
  type Releasable,
} from "../../src/lib/services/queue-lifecycle.js";
import {
  createDeterministicRandom,
  randomChance,
  randomInt,
  sleep,
  withTimeout,
} from "../helpers/fuzz-utils.js";

type QueueErrorClass =
  | typeof QueueClosedError
  | typeof QueueConnectError
  | typeof QueueReleaseError;

function expectQueueError(
  error: unknown,
  expectedClass: QueueErrorClass,
  expectedCode: QueueErrorCode,
  expectedCause?: unknown,
): true {
  assert.ok(error instanceof expectedClass);
  assert.equal(error.code, expectedCode);
  if (expectedCause !== undefined) {
    assert.equal(error.cause, expectedCause);
  }
  return true;
}

function createMockUtils(): Releasable & { released: boolean } {
  return {
    released: false,
    async release() {
      this.released = true;
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("acquire returns connected utils", async () => {
  const mockUtils = createMockUtils();
  const manager = createQueueManager(async () => mockUtils);
  const utils = await manager.acquire();
  assert.equal(utils, mockUtils);
});

test("acquire coalesces concurrent callers on the same connection", async () => {
  let connectCount = 0;
  const mockUtils = createMockUtils();
  const manager = createQueueManager(async () => {
    connectCount++;
    return mockUtils;
  });

  const [a, b, c] = await Promise.all([
    manager.acquire(),
    manager.acquire(),
    manager.acquire(),
  ]);

  assert.equal(a, mockUtils);
  assert.equal(b, mockUtils);
  assert.equal(c, mockUtils);
  assert.equal(connectCount, 1);
});

test("acquire reuses ready utils without reconnecting", async () => {
  let connectCount = 0;
  const mockUtils = createMockUtils();
  const manager = createQueueManager(async () => {
    connectCount++;
    return mockUtils;
  });

  await manager.acquire();
  await manager.acquire();
  await manager.acquire();
  assert.equal(connectCount, 1);
});

test("acquire throws after close", async () => {
  const manager = createQueueManager(async () => createMockUtils());
  await manager.close();
  await assert.rejects(
    () => manager.acquire(),
    (error) =>
      expectQueueError(error, QueueClosedError, QUEUE_ERROR_CODES.CLOSED),
  );
});

test("close releases ready utils", async () => {
  const mockUtils = createMockUtils();
  const manager = createQueueManager(async () => mockUtils);
  await manager.acquire();
  assert.equal(mockUtils.released, false);

  await manager.close();
  assert.equal(mockUtils.released, true);
  await assert.rejects(
    () => manager.acquire(),
    (error) =>
      expectQueueError(error, QueueClosedError, QUEUE_ERROR_CODES.CLOSED),
  );
});

test("close during initialization waits for init then releases", async () => {
  const mockUtils = createMockUtils();
  const init = deferred<Releasable>();
  const manager = createQueueManager(() => init.promise);

  // Start acquisition (blocks on init)
  const acquirePromise = manager.acquire();

  // Request close while init is pending
  const closePromise = manager.close();

  // Resolve init — close should release the utils
  init.resolve(mockUtils);
  await closePromise;

  assert.equal(mockUtils.released, true);
  await assert.rejects(
    () => acquirePromise,
    (error) =>
      expectQueueError(error, QueueClosedError, QUEUE_ERROR_CODES.CLOSED),
  );
});

test("close during failed initialization transitions to closed", async () => {
  const init = deferred<Releasable>();
  const manager = createQueueManager(() => init.promise);

  // Start acquisition (blocks on init)
  const acquirePromise = manager.acquire();

  // Request close while init is pending
  const closePromise = manager.close();

  // Reject init — nothing to release, close should succeed
  init.reject(new Error("connection refused"));
  await closePromise;

  // acquire should see "closed", not the connection error
  await assert.rejects(
    () => acquirePromise,
    (error) =>
      expectQueueError(error, QueueClosedError, QUEUE_ERROR_CODES.CLOSED),
  );
});

test("acquire swallows close errors and retries on next call", async () => {
  let connectCount = 0;
  const goodUtils = createMockUtils();
  const releaseFailure = new Error("release failed");
  const failingUtils: Releasable = {
    async release() {
      throw releaseFailure;
    },
  };

  const manager = createQueueManager(async () => {
    connectCount++;
    if (connectCount === 1) return failingUtils;
    return goodUtils;
  });

  // First acquire succeeds
  await manager.acquire();

  // Close fails because release throws — state reverts to idle
  await assert.rejects(
    () => manager.close(),
    (error) =>
      expectQueueError(
        error,
        QueueReleaseError,
        QUEUE_ERROR_CODES.RELEASE_FAILED,
        releaseFailure,
      ),
  );

  // Second acquire should reconnect (not throw "closed" or "release failed")
  const utils = await manager.acquire();
  assert.equal(utils, goodUtils);
  assert.equal(connectCount, 2);
});

test("acquire retries after connection failure", async () => {
  let connectCount = 0;
  const mockUtils = createMockUtils();
  const connectionFailure = new Error("connection refused");
  const manager = createQueueManager(async () => {
    connectCount++;
    if (connectCount === 1) throw connectionFailure;
    return mockUtils;
  });

  await assert.rejects(
    () => manager.acquire(),
    (error) =>
      expectQueueError(
        error,
        QueueConnectError,
        QUEUE_ERROR_CODES.CONNECT_FAILED,
        connectionFailure,
      ),
  );

  const utils = await manager.acquire();
  assert.equal(utils, mockUtils);
  assert.equal(connectCount, 2);
});

test("concurrent close callers coalesce on the same promise", async () => {
  const mockUtils = createMockUtils();
  const manager = createQueueManager(async () => mockUtils);
  await manager.acquire();

  // Both close calls should resolve without error
  await Promise.all([manager.close(), manager.close()]);
  assert.equal(mockUtils.released, true);
});

test("close is idempotent", async () => {
  const manager = createQueueManager(async () => createMockUtils());
  await manager.close();
  await manager.close();
  await assert.rejects(
    () => manager.acquire(),
    (error) =>
      expectQueueError(error, QueueClosedError, QUEUE_ERROR_CODES.CLOSED),
  );
});

test("randomized acquire/close schedule preserves lifecycle invariants", async () => {
  const random = createDeterministicRandom(0x5eedc0de);
  const rounds = 16;
  const actionsPerRound = 80;

  for (let round = 0; round < rounds; round += 1) {
    let connectInFlight = 0;
    let maxConnectInFlight = 0;
    let successfulConnectCount = 0;
    let releaseCallCount = 0;
    let closeSuccessCount = 0;
    let injectReleaseFailures = true;
    const seenUtils = new Set<object>();

    const manager = createQueueManager(async () => {
      connectInFlight += 1;
      maxConnectInFlight = Math.max(maxConnectInFlight, connectInFlight);

      try {
        await sleep(randomInt(random, 0, 4));

        if (randomChance(random, 0.2)) {
          throw new Error(`connect failed in round ${round.toString()}`);
        }

        const utils = {
          id: `${round.toString()}-${successfulConnectCount.toString()}`,
          async release() {
            releaseCallCount += 1;
            await sleep(randomInt(random, 0, 4));
            if (injectReleaseFailures && randomChance(random, 0.15)) {
              throw new Error(`release failed in round ${round.toString()}`);
            }
          },
        };

        successfulConnectCount += 1;
        seenUtils.add(utils);
        return utils;
      } finally {
        connectInFlight -= 1;
      }
    });

    const operationPromises = Array.from({ length: actionsPerRound }, () =>
      (async () => {
        await sleep(randomInt(random, 0, 5));
        const runAcquire = randomChance(random, 0.65);

        if (runAcquire) {
          const startedAfterClose = closeSuccessCount > 0;
          try {
            const utils = await manager.acquire();
            assert.equal(
              seenUtils.has(utils),
              true,
              "acquire returned an unknown utils instance",
            );
            if (startedAfterClose) {
              assert.fail(
                "acquire resolved successfully even though manager was already closed",
              );
            }
          } catch (error) {
            assert.equal(
              error instanceof QueueClosedError || error instanceof QueueConnectError,
              true,
              "acquire rejected with unexpected error class",
            );
          }
          return;
        }

        try {
          await manager.close();
          closeSuccessCount += 1;
        } catch (error) {
          assert.equal(
            error instanceof QueueReleaseError,
            true,
            "close rejected with unexpected error class",
          );
        }
      })(),
    );

    await withTimeout(
      Promise.all(operationPromises).then(() => undefined),
      10_000,
      `queue lifecycle random round ${round.toString()} timed out`,
    );

    // Final close should deterministically terminate the manager. Release
    // failures above are intentionally injected for concurrent lifecycle paths.
    injectReleaseFailures = false;
    await manager.close();

    assert.equal(
      maxConnectInFlight <= 1,
      true,
      "connect should never run concurrently across callers",
    );
    assert.equal(
      releaseCallCount <= successfulConnectCount,
      true,
      "release calls cannot exceed successful connections",
    );

    await Promise.all(
      Array.from({ length: 8 }, async () => {
        await assert.rejects(
          () => manager.acquire(),
          (error) =>
            expectQueueError(error, QueueClosedError, QUEUE_ERROR_CODES.CLOSED),
        );
      }),
    );
  }
});
