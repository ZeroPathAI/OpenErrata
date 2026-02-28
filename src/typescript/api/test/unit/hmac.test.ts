import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { getEnv } from "../../src/lib/config/env.js";
import { verifyHmac } from "../../src/lib/services/hmac.js";

function sign(body: string): string {
  return createHmac("sha256", getEnv().HMAC_SECRET).update(body).digest("hex");
}

test("verifyHmac accepts signatures computed with the configured secret", async () => {
  const body = '{"message":"hello"}';
  const signature = sign(body);

  const accepted = await verifyHmac(body, signature);
  assert.equal(accepted, true);
});

test("verifyHmac rejects wrong signatures and mismatched lengths", async () => {
  const body = '{"message":"hello"}';
  const goodSignature = sign(body);
  const wrongBodySignature = sign('{"message":"different"}');
  const sameLengthWrongSignature =
    goodSignature.slice(0, -1) + (goodSignature.endsWith("0") ? "1" : "0");

  assert.equal(await verifyHmac(body, wrongBodySignature), false);
  assert.equal(await verifyHmac(body, sameLengthWrongSignature), false);
  assert.equal(await verifyHmac(body, "short"), false);
});
