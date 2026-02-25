import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bootOpenErrataController,
  type OpenErrataBootstrapTarget,
  type OpenErrataControllerLifecycle,
} from "../../src/content/bootstrap.js";

type TestController = OpenErrataControllerLifecycle & {
  id: string;
  bootCalls: number;
  disposeCalls: number;
};

function createController(
  id: string,
  events: string[],
  options: { throwOnDispose?: boolean } = {},
): TestController {
  return {
    id,
    bootCalls: 0,
    disposeCalls: 0,
    boot() {
      this.bootCalls += 1;
      events.push(`boot:${id}`);
    },
    dispose() {
      this.disposeCalls += 1;
      events.push(`dispose:${id}`);
      if (options.throwOnDispose) {
        throw new Error(`dispose failed for ${id}`);
      }
    },
  };
}

test("bootOpenErrataController boots a new controller and stores it on target", () => {
  const events: string[] = [];
  const target: OpenErrataBootstrapTarget<TestController> = {};
  const next = createController("next", events);

  const result = bootOpenErrataController(target, () => next);

  assert.equal(result, next);
  assert.equal(target.__openerrata_loaded, true);
  assert.equal(target.__openerrata_controller, next);
  assert.equal(next.bootCalls, 1);
  assert.equal(next.disposeCalls, 0);
  assert.deepEqual(events, ["boot:next"]);
});

test("bootOpenErrataController disposes existing controller before booting replacement", () => {
  const events: string[] = [];
  const previous = createController("previous", events);
  const target: OpenErrataBootstrapTarget<TestController> = {
    __openerrata_controller: previous,
  };
  const next = createController("next", events);

  bootOpenErrataController(target, () => next);

  assert.equal(previous.disposeCalls, 1);
  assert.equal(next.bootCalls, 1);
  assert.equal(target.__openerrata_controller, next);
  assert.deepEqual(events, ["dispose:previous", "boot:next"]);
});

test("bootOpenErrataController ignores stale loaded flag and still boots", () => {
  const events: string[] = [];
  const target: OpenErrataBootstrapTarget<TestController> = {
    __openerrata_loaded: true,
  };
  const next = createController("next", events);

  bootOpenErrataController(target, () => next);

  assert.equal(next.bootCalls, 1);
  assert.equal(target.__openerrata_controller, next);
  assert.equal(target.__openerrata_loaded, true);
  assert.deepEqual(events, ["boot:next"]);
});

test("bootOpenErrataController still boots replacement when previous dispose throws", () => {
  const events: string[] = [];
  const previous = createController("previous", events, { throwOnDispose: true });
  const target: OpenErrataBootstrapTarget<TestController> = {
    __openerrata_controller: previous,
  };
  const next = createController("next", events);
  const originalDebug = console.debug;
  const debugCalls: unknown[][] = [];
  console.debug = (...args: unknown[]) => {
    debugCalls.push(args);
  };

  try {
    bootOpenErrataController(target, () => next);
  } finally {
    console.debug = originalDebug;
  }

  assert.equal(previous.disposeCalls, 1);
  assert.equal(next.bootCalls, 1);
  assert.equal(target.__openerrata_controller, next);
  assert.deepEqual(events, ["dispose:previous", "boot:next"]);
  assert.equal(debugCalls.length, 1);
});
