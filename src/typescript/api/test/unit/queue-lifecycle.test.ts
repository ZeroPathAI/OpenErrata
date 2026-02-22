import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createQueueManager,
  type Releasable,
} from "../../src/lib/services/queue-lifecycle.js";

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
  await assert.rejects(() => manager.acquire(), { message: /closed/ });
});

test("close releases ready utils", async () => {
  const mockUtils = createMockUtils();
  const manager = createQueueManager(async () => mockUtils);
  await manager.acquire();
  assert.equal(mockUtils.released, false);

  await manager.close();
  assert.equal(mockUtils.released, true);
  await assert.rejects(() => manager.acquire(), { message: /closed/ });
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
  await assert.rejects(() => acquirePromise, { message: /closed/ });
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
  await assert.rejects(() => acquirePromise, { message: /closed/ });
});

test("acquire swallows close errors and retries on next call", async () => {
  let connectCount = 0;
  const goodUtils = createMockUtils();
  const failingUtils: Releasable = {
    async release() {
      throw new Error("release failed");
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
  await assert.rejects(() => manager.close(), { message: /release failed/ });

  // Second acquire should reconnect (not throw "closed" or "release failed")
  const utils = await manager.acquire();
  assert.equal(utils, goodUtils);
  assert.equal(connectCount, 2);
});

test("acquire retries after connection failure", async () => {
  let connectCount = 0;
  const mockUtils = createMockUtils();
  const manager = createQueueManager(async () => {
    connectCount++;
    if (connectCount === 1) throw new Error("connection refused");
    return mockUtils;
  });

  await assert.rejects(() => manager.acquire(), {
    message: /connection refused/,
  });

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
  await assert.rejects(() => manager.acquire(), { message: /closed/ });
});
