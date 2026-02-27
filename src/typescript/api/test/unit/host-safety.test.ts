import assert from "node:assert/strict";
import { test } from "node:test";
import { hasAddressIntersection, isPrivateIpAddress } from "../../src/lib/network/host-safety.js";

test("isPrivateIpAddress blocks reserved IPv4 ranges used for SSRF bypasses", () => {
  assert.equal(isPrivateIpAddress("100.64.0.1"), true);
  assert.equal(isPrivateIpAddress("198.18.0.1"), true);
  assert.equal(isPrivateIpAddress("240.0.0.1"), true);
  assert.equal(isPrivateIpAddress("255.255.255.255"), true);
});

test("isPrivateIpAddress blocks mapped IPv4 private ranges in IPv6 notation", () => {
  assert.equal(isPrivateIpAddress("::ffff:192.168.1.1"), true);
  assert.equal(isPrivateIpAddress("::ffff:c0a8:0101"), true);
  assert.equal(isPrivateIpAddress("[::ffff:c0a8:0101]"), true);
});

test("isPrivateIpAddress allows normal public addresses", () => {
  assert.equal(isPrivateIpAddress("8.8.8.8"), false);
  assert.equal(isPrivateIpAddress("2606:4700:4700::1111"), false);
  assert.equal(isPrivateIpAddress("[2606:4700:4700::1111]"), false);
});

test("hasAddressIntersection compares address sets case-insensitively", () => {
  assert.equal(hasAddressIntersection(["2001:DB8::1", "203.0.113.5"], ["203.0.113.5"]), true);
  assert.equal(hasAddressIntersection(["2001:DB8::1"], ["2001:db8::2"]), false);
});
