import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bootOpenErrataControllerOnce,
  type OpenErrataBootstrapTarget,
} from "../../src/content/bootstrap.js";

function createController(id: string, events: string[]) {
  return {
    id,
    boot() {
      events.push(`boot:${id}`);
    },
  };
}

test("the first injection boots a controller and stores it on the page's isolated world", () => {
  const events: string[] = [];
  const target: OpenErrataBootstrapTarget<ReturnType<typeof createController>> = {};
  const controller = bootOpenErrataControllerOnce(target, () => createController("first", events));

  assert.equal(target.__openerrata_controller, controller);
  assert.deepEqual(events, ["boot:first"]);
});

test("a repeated injection keeps the live controller instead of booting a second one", () => {
  const events: string[] = [];
  const target: OpenErrataBootstrapTarget<ReturnType<typeof createController>> = {};
  const first = bootOpenErrataControllerOnce(target, () => createController("first", events));
  const second = bootOpenErrataControllerOnce(target, () => createController("second", events));

  assert.equal(second, first);
  assert.deepEqual(events, ["boot:first"]);
});
