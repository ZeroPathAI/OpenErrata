import assert from "node:assert/strict";
import { test } from "node:test";
import { requireMountTarget } from "../../src/lib/page-bootstrap";
import { withDom } from "../helpers/dom";

test("requireMountTarget returns configured mount element and throws when missing", () => {
  withDom('<div id="app"></div><div id="custom-root"></div>', () => {
    assert.equal(requireMountTarget({ pageLabel: "popup" }).id, "app");
    assert.equal(
      requireMountTarget({ pageLabel: "options", mountId: "custom-root" }).id,
      "custom-root",
    );
    assert.throws(
      () => requireMountTarget({ pageLabel: "options", mountId: "missing" }),
      /Missing #missing mount point for options page/,
    );
  });
});
