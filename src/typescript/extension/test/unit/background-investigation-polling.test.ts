import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { POLL_INTERVAL_MS, type GetInvestigationOutput } from "@openerrata/shared";
import { ApiClientError } from "../../src/background/api-client-error";
import {
  InvestigationPolling,
  pollRecoveryAlarmTabId,
} from "../../src/background/investigation-polling";
import { TabStates } from "../../src/background/tab-state";
import { claim, investigatingStatus, sessionId } from "../helpers/statuses";

const INVESTIGATING_OUTPUT: GetInvestigationOutput = {
  investigationState: "INVESTIGATING",
  status: "PROCESSING",
  provenance: "CLIENT_FALLBACK",
  pendingClaims: [],
  confirmedClaims: [],
  priorInvestigationResult: null,
};

const INVESTIGATED_OUTPUT: GetInvestigationOutput = {
  investigationState: "INVESTIGATED",
  provenance: "CLIENT_FALLBACK",
  claims: [claim("The moon is cheese")],
  checkedAt: "2026-10-02T00:00:00.000Z",
};

async function flush(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function setup(responses: (() => Promise<GetInvestigationOutput>)[]) {
  const storage: Record<string, unknown> = {};
  const tabStates = new TabStates({
    storage: {
      get: (key) => Promise.resolve(key in storage ? { [key]: storage[key] } : {}),
      set: (items) => {
        Object.assign(storage, items);
        return Promise.resolve();
      },
      remove: (key) => {
        Reflect.deleteProperty(storage, key);
        return Promise.resolve();
      },
    },
    notifyTab: () => Promise.resolve(),
    updateBadge: () => undefined,
    listTabIds: () => Promise.resolve([1]),
  });
  const alarms = new Set<string>();
  let calls = 0;
  const polling = new InvestigationPolling({
    tabStates,
    getInvestigation: () => {
      const response = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      if (response === undefined) throw new Error("no response configured");
      return response();
    },
    alarms: {
      create: (name) => {
        alarms.add(name);
        return Promise.resolve();
      },
      clear: (name) => Promise.resolve(alarms.delete(name)),
    },
  });
  return { tabStates, polling, alarms, callCount: () => calls };
}

test("polling follows an investigation until it completes, then stops", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { tabStates, polling, alarms, callCount } = setup([
      () => Promise.resolve(INVESTIGATING_OUTPUT),
      () => Promise.resolve(INVESTIGATED_OUTPUT),
    ]);
    tabStates.claimSession(1, sessionId(1));
    await tabStates.putStatus(1, investigatingStatus(sessionId(1)));

    polling.follow(1, investigatingStatus(sessionId(1)));
    await flush();
    assert.equal(callCount(), 1);
    assert.deepEqual(Array.from(alarms), ["investigation-poll:1"]);

    mock.timers.tick(POLL_INTERVAL_MS);
    await flush();
    assert.equal(callCount(), 2);
    const settled = await tabStates.getStatus(1);
    assert.equal(settled?.kind === "POST" && settled.investigationState, "INVESTIGATED");
    assert.deepEqual(Array.from(alarms), []);

    mock.timers.tick(POLL_INTERVAL_MS * 10);
    await flush();
    assert.equal(callCount(), 2, "no polling after the investigation settled");
  } finally {
    mock.timers.reset();
  }
});

test("transient poll failures back off and eventually give up with an API_ERROR status", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { tabStates, polling, callCount } = setup([
      () => Promise.reject(new Error("network down")),
    ]);
    tabStates.claimSession(1, sessionId(1));
    await tabStates.putStatus(1, investigatingStatus(sessionId(1)));

    const originalError = console.error;
    console.error = () => undefined;
    try {
      polling.follow(1, investigatingStatus(sessionId(1)));
      await flush();
      for (let attempt = 1; attempt < 5; attempt += 1) {
        assert.equal(callCount(), attempt);
        mock.timers.tick(POLL_INTERVAL_MS * 2 ** attempt);
        await flush();
      }
    } finally {
      console.error = originalError;
    }
    assert.equal(callCount(), 5);
    const status = await tabStates.getStatus(1);
    assert.equal(status?.kind === "POST" && status.investigationState, "API_ERROR");
  } finally {
    mock.timers.reset();
  }
});

test("a non-retryable API error ends polling at once", async () => {
  const { tabStates, polling, callCount } = setup([
    () => Promise.reject(new ApiClientError("upgrade required", { errorCode: "UPGRADE_REQUIRED" })),
  ]);
  tabStates.claimSession(1, sessionId(1));
  await tabStates.putStatus(1, investigatingStatus(sessionId(1)));

  const originalError = console.error;
  console.error = () => undefined;
  try {
    polling.follow(1, investigatingStatus(sessionId(1)));
    await flush();
  } finally {
    console.error = originalError;
  }
  assert.equal(callCount(), 1);
  const status = await tabStates.getStatus(1);
  assert.equal(status?.kind === "POST" && status.investigationState, "API_ERROR");
});

test("polling stops when the followed page session ends", async () => {
  const { tabStates, polling, callCount } = setup([() => Promise.resolve(INVESTIGATING_OUTPUT)]);
  tabStates.claimSession(1, sessionId(1));
  await tabStates.putStatus(1, investigatingStatus(sessionId(1)));
  await tabStates.retireSession(1, sessionId(1));

  polling.follow(1, investigatingStatus(sessionId(1)));
  await flush();
  assert.equal(callCount(), 0);
});

test("pollRecoveryAlarmTabId only accepts this module's alarm names", () => {
  assert.equal(pollRecoveryAlarmTabId("investigation-poll:42"), 42);
  assert.equal(pollRecoveryAlarmTabId("investigation-poll:x"), null);
  assert.equal(pollRecoveryAlarmTabId("other:42"), null);
});
