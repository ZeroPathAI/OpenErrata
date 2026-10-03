import assert from "node:assert/strict";
import { test } from "node:test";
import { assertClientAddressSourceConfigured } from "../../src/lib/config/startup.js";

/**
 * In production the API sits behind the ingress proxy; without a trusted
 * client-address header every viewer would share the proxy's IP range and the
 * per-range view-credit cap would flatten selector ranking.
 */

test("production API refuses to start without ADDRESS_HEADER", () => {
  assert.throws(() => assertClientAddressSourceConfigured({}), /ADDRESS_HEADER/);
  assert.throws(
    () => assertClientAddressSourceConfigured({ ADDRESS_HEADER: " " }),
    /ADDRESS_HEADER/,
  );
});

test("X-Forwarded-For needs an explicit positive XFF_DEPTH", () => {
  for (const XFF_DEPTH of [undefined, "", "0", "-1", "one"]) {
    assert.throws(
      () =>
        assertClientAddressSourceConfigured({
          ADDRESS_HEADER: "X-Forwarded-For",
          ...(XFF_DEPTH === undefined ? {} : { XFF_DEPTH }),
        }),
      /XFF_DEPTH/,
      String(XFF_DEPTH),
    );
  }
});

test("the chart's defaults and single-value headers are accepted", () => {
  assertClientAddressSourceConfigured({ ADDRESS_HEADER: "x-forwarded-for", XFF_DEPTH: "1" });
  assertClientAddressSourceConfigured({ ADDRESS_HEADER: "cf-connecting-ip" });
});
