import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveIpRangePrefix } from "../../src/lib/network/ip.js";

test("deriveIpRangePrefix normalizes IPv4 addresses to /24 prefixes", () => {
  assert.equal(deriveIpRangePrefix("203.0.113.99"), "203.0.113");
  assert.equal(deriveIpRangePrefix(" 198.51.100.7 "), "198.51.100");
});

test("deriveIpRangePrefix returns normalized IPv6 prefixes", () => {
  assert.equal(deriveIpRangePrefix("2001:0db8::1"), "2001:db8:0");
  assert.equal(deriveIpRangePrefix("fe80::1%eth0"), "fe80:0:0");
});

test("deriveIpRangePrefix collapses IPv4-mapped IPv6 to IPv4 /24 prefixes", () => {
  assert.equal(deriveIpRangePrefix("::ffff:192.168.1.77"), "192.168.1");
});

test("deriveIpRangePrefix returns invalid marker for malformed input", () => {
  assert.equal(deriveIpRangePrefix("999.1.1.1"), "invalid:999.1.1.1");
  assert.equal(deriveIpRangePrefix("2001::db8::1"), "invalid:2001::db8::1");
  assert.equal(deriveIpRangePrefix("NotAnIp"), "invalid:notanip");
});

test("deriveIpRangePrefix returns unknown for empty client addresses", () => {
  assert.equal(deriveIpRangePrefix(""), "unknown");
  assert.equal(deriveIpRangePrefix("   "), "unknown");
});
