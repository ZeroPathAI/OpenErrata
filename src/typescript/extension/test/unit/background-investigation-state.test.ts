import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BackgroundInvestigationState,
  type InvestigationPoller,
} from "../../src/background/investigation-state.js";

function buildPoller(overrides: Partial<InvestigationPoller> = {}): InvestigationPoller {
  return {
    tabSessionId: 1,
    investigationId: "inv-1",
    inFlight: false,
    timer: null,
    ...overrides,
  };
}

test("BackgroundInvestigationState tracks latest tab sessions and staleness", () => {
  const state = new BackgroundInvestigationState();

  assert.equal(state.isStaleTabSession(10, 1), false);
  state.noteTabSession(10, 1);
  assert.equal(state.isStaleTabSession(10, 1), false);
  assert.equal(state.isStaleTabSession(10, 0), true);

  state.noteTabSession(10, 0);
  assert.equal(state.isStaleTabSession(10, 0), true);

  state.noteTabSession(10, 3);
  assert.equal(state.isStaleTabSession(10, 2), true);
  assert.equal(state.isStaleTabSession(10, 3), false);
});

test("BackgroundInvestigationState retires and clears tab sessions", () => {
  const state = new BackgroundInvestigationState();

  state.noteTabSession(11, 5);
  state.retireTabSession(11, 5);
  assert.equal(state.isStaleTabSession(11, 5), true);
  assert.equal(state.isStaleTabSession(11, 6), false);

  state.clearTabSession(11);
  assert.equal(state.isStaleTabSession(11, 5), false);
});

test("BackgroundInvestigationState stores pollers by tab", () => {
  const state = new BackgroundInvestigationState();

  const first = buildPoller({ tabSessionId: 1, investigationId: "inv-a" });
  const second = buildPoller({ tabSessionId: 2, investigationId: "inv-b" });
  state.setPoller(21, first);
  state.setPoller(22, second);

  assert.equal(state.getPoller(21), first);
  assert.equal(state.getPoller(22), second);
  assert.deepEqual(
    Array.from(state.pollerTabIds()).sort((a, b) => a - b),
    [21, 22],
  );

  state.clearPoller(21);
  assert.equal(state.getPoller(21), undefined);
  assert.deepEqual(Array.from(state.pollerTabIds()), [22]);
});
