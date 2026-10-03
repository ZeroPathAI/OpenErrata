import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveIpRangePrefix } from "../../src/lib/network/ip.js";

test("deriveIpRangePrefix normalizes IPv4 addresses to /24 prefixes", () => {
  assert.equal(deriveIpRangePrefix("203.0.113.99"), "203.0.113");
  assert.equal(deriveIpRangePrefix(" 198.51.100.7 "), "198.51.100");
});

test("deriveIpRangePrefix returns normalized IPv6 /48 prefixes", () => {
  assert.equal(deriveIpRangePrefix("2001:0db8::1"), "2001:db8:0");
  assert.equal(deriveIpRangePrefix("fe80::1%eth0"), "fe80:0:0");
});

test("deriveIpRangePrefix collapses IPv4-mapped IPv6 to IPv4 /24 prefixes", () => {
  assert.equal(deriveIpRangePrefix("::ffff:192.168.1.77"), "192.168.1");
});

test("deriveIpRangePrefix rejects anything that is not an IP address", () => {
  // A non-IP client address means the proxy header configuration is broken;
  // bucketing such clients together would silently merge their view credits.
  for (const value of ["999.1.1.1", "2001::db8::1", "NotAnIp", "", "   ", "10.1"]) {
    assert.throws(() => deriveIpRangePrefix(value), /not an IP address/, JSON.stringify(value));
  }
});
