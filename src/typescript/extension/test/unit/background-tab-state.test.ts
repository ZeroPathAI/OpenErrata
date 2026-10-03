import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionPageStatus } from "@openerrata/shared";
import { TabStates } from "../../src/background/tab-state";
import { createDeterministicRandom, randomInt } from "../helpers/fuzz-utils";
import {
  investigatedStatus,
  notInvestigatedStatus,
  sessionId,
  skippedStatus,
} from "../helpers/statuses";

function createTabStates(storageRecord: Record<string, unknown> = {}) {
  const notified: { tabId: number; status: ExtensionPageStatus }[] = [];
  const badges: { tabId: number; status: ExtensionPageStatus | null }[] = [];
  const tabStates = new TabStates({
    storage: {
      get: (key) => Promise.resolve(key in storageRecord ? { [key]: storageRecord[key] } : {}),
      set: (items) => {
        Object.assign(storageRecord, items);
        return Promise.resolve();
      },
      remove: (key) => {
        Reflect.deleteProperty(storageRecord, key);
        return Promise.resolve();
      },
    },
    notifyTab: (tabId, status) => {
      notified.push({ tabId, status });
      return Promise.resolve();
    },
    updateBadge: (tabId, status) => {
      badges.push({ tabId, status });
    },
    listTabIds: () => Promise.resolve([1, 2]),
  });
  return { tabStates, storageRecord, notified, badges };
}

test("a newer page session supersedes the previous one, which can never become current again", async () => {
  const { tabStates } = createTabStates();
  assert.equal(tabStates.claimSession(1, sessionId(1)), true);
  assert.equal(tabStates.claimSession(1, sessionId(2)), true);
  assert.equal(tabStates.claimSession(1, sessionId(1)), false);

  // A late reply for the superseded session is not cached.
  assert.equal(await tabStates.putStatus(1, notInvestigatedStatus(sessionId(1))), false);
  assert.equal(await tabStates.getStatus(1), null);
  assert.equal(await tabStates.putStatus(1, notInvestigatedStatus(sessionId(2))), true);
  assert.deepEqual(await tabStates.getStatus(1), notInvestigatedStatus(sessionId(2)));
});

test("retiring a session clears its status but not a newer session's", async () => {
  const { tabStates } = createTabStates();
  tabStates.claimSession(1, sessionId(1));
  await tabStates.putStatus(1, skippedStatus(sessionId(1)));
  tabStates.claimSession(1, sessionId(2));
  await tabStates.putStatus(1, notInvestigatedStatus(sessionId(2)));

  await tabStates.retireSession(1, sessionId(1));
  assert.deepEqual(await tabStates.getStatus(1), notInvestigatedStatus(sessionId(2)));

  await tabStates.retireSession(1, sessionId(2));
  assert.equal(await tabStates.getStatus(1), null);
  assert.equal(tabStates.claimSession(1, sessionId(2)), false);
});

test("cached statuses are persisted, pushed to the tab and reflected in its badge", async () => {
  const { tabStates, storageRecord, notified, badges } = createTabStates();
  tabStates.claimSession(7, sessionId(1));
  const status = investigatedStatus(sessionId(1));
  await tabStates.putStatus(7, status);

  assert.deepEqual(storageRecord["tab:7"], status);
  assert.deepEqual(notified, [{ tabId: 7, status }]);
  assert.deepEqual(badges.at(-1), { tabId: 7, status });

  await tabStates.forgetTab(7);
  assert.equal("tab:7" in storageRecord, false);
  assert.deepEqual(badges.at(-1), { tabId: 7, status: null });
});

test("after a service-worker restart the persisted status's session is still the current one", async () => {
  const storage: Record<string, unknown> = {};
  const first = createTabStates(storage).tabStates;
  first.claimSession(3, sessionId(5));
  await first.putStatus(3, notInvestigatedStatus(sessionId(5)));

  const restarted = createTabStates(storage).tabStates;
  assert.deepEqual(await restarted.getStatus(3), notInvestigatedStatus(sessionId(5)));
  // Polling resumed after the restart may keep updating that session...
  assert.equal(await restarted.putStatus(3, investigatedStatus(sessionId(5))), true);
  // ...but not a session the background has never heard of.
  assert.equal(await restarted.putStatus(3, investigatedStatus(sessionId(6))), false);
});

test("TabStates matches a reference model under random message sequences", async () => {
  const random = createDeterministicRandom(42);
  for (let round = 0; round < 40; round += 1) {
    const { tabStates } = createTabStates();
    const model = {
      current: null as number | null,
      retired: new Set<number>(),
      status: null as number | null,
    };
    for (let step = 0; step < 30; step += 1) {
      const session = randomInt(random, 1, 4);
      switch (randomInt(random, 0, 3)) {
        case 0: {
          const accepted = tabStates.claimSession(1, sessionId(session));
          const expected = !model.retired.has(session);
          assert.equal(accepted, expected);
          if (expected) {
            if (model.current !== null && model.current !== session)
              model.retired.add(model.current);
            model.current = session;
          }
          break;
        }
        case 1: {
          await tabStates.retireSession(1, sessionId(session));
          model.retired.add(session);
          if (model.current === session) model.current = null;
          if (model.status === session) model.status = null;
          break;
        }
        case 2: {
          const written = await tabStates.putStatus(1, notInvestigatedStatus(sessionId(session)));
          assert.equal(written, model.current === session);
          if (written) model.status = session;
          break;
        }
        default: {
          await tabStates.forgetTab(1);
          model.current = null;
          model.retired.clear();
          model.status = null;
        }
      }
      const status = await tabStates.getStatus(1);
      assert.deepEqual(
        status?.tabSessionId ?? null,
        model.status === null ? null : sessionId(model.status),
      );
    }
  }
});
