import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLineDiff } from "../../src/lib/services/update-lineage.js";

test("buildLineDiff reports no changes for identical text", () => {
  assert.equal(buildLineDiff("same\ncontent", "same\ncontent"), "No changes detected.");
});

test("buildLineDiff reports the differing middle as removed and added lines", () => {
  const diff = buildLineDiff("keep one\nremove me\nkeep tail", "keep one\nadd me\nkeep tail");
  assert.equal(
    diff,
    "Diff summary (line context):\n- Removed lines:\nremove me\n+ Added lines:\nadd me",
  );
});

test("buildLineDiff marks a pure insertion with no removed lines", () => {
  const diff = buildLineDiff("head\ntail", "head\nnew\ntail");
  assert.match(diff, /- Removed lines:\n\(none\)/);
  assert.match(diff, /\+ Added lines:\nnew/);
});
