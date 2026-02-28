import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyHmac } from "../../src/lib/services/hmac.js";

const TEST_SECRET = "test-hmac-secret";

function sign(body: string): string {
  return createHmac("sha256", TEST_SECRET).update(body).digest("hex");
}

test("verifyHmac accepts signatures computed with the configured secret", async () => {
  const body = '{"message":"hello"}';
  const signature = sign(body);

  const accepted = await verifyHmac(TEST_SECRET, body, signature);
  assert.equal(accepted, true);
});

test("verifyHmac rejects wrong signatures and mismatched lengths", async () => {
  const body = '{"message":"hello"}';
  const goodSignature = sign(body);
  const wrongBodySignature = sign('{"message":"different"}');
  const sameLengthWrongSignature =
    goodSignature.slice(0, -1) + (goodSignature.endsWith("0") ? "1" : "0");

  assert.equal(await verifyHmac(TEST_SECRET, body, wrongBodySignature), false);
  assert.equal(await verifyHmac(TEST_SECRET, body, sameLengthWrongSignature), false);
  assert.equal(await verifyHmac(TEST_SECRET, body, "short"), false);
});
