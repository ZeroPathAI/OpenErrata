import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import ipaddr from "ipaddr.js";
import {
  isLocallyScopedHostname,
  isPublicUnicastAddress,
  parseIpLiteral,
} from "../../src/lib/network/host-safety.js";
import {
  BlockedDestinationError,
  fetchPublicHttp,
  publicOnlyLookup,
} from "../../src/lib/network/public-http-fetch.js";

function isPublic(address: string): boolean {
  return isPublicUnicastAddress(ipaddr.parse(address));
}

test("isPublicUnicastAddress rejects private, loopback, link-local, CGNAT and reserved IPv4", () => {
  for (const address of [
    "10.0.0.1",
    "172.16.5.4",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "192.0.0.1",
    "240.0.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "0.0.0.0",
  ]) {
    assert.equal(isPublic(address), false, address);
  }
});

test("isPublicUnicastAddress rejects IPv6 forms that can reach internal networks", () => {
  for (const address of [
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1", // NAT64 well-known prefix
    "64:ff9b:1::a00:1", // NAT64 local-use prefix
    "2002:a00:1::1", // 6to4
    "2001::1", // Teredo
    "2001:db8::1",
  ]) {
    assert.equal(isPublic(address), false, address);
  }
});

test("isPublicUnicastAddress accepts ordinary public addresses", () => {
  assert.equal(isPublic("8.8.8.8"), true);
  assert.equal(isPublic("2606:4700:4700::1111"), true);
});

test("parseIpLiteral recognizes bracketed and zoned IPv6 literals but not DNS names", () => {
  assert.equal(parseIpLiteral("[::1]")?.toString(), "::1");
  assert.equal(parseIpLiteral("fe80::1%eth0")?.toString(), "fe80::1");
  assert.equal(parseIpLiteral("203.0.113.5")?.toString(), "203.0.113.5");
  assert.equal(parseIpLiteral("example.com"), null);
});

test("isLocallyScopedHostname flags localhost-style names", () => {
  assert.equal(isLocallyScopedHostname("localhost"), true);
  assert.equal(isLocallyScopedHostname("LOCALHOST."), true);
  assert.equal(isLocallyScopedHostname("printer.local"), true);
  assert.equal(isLocallyScopedHostname("app.localhost"), true);
  assert.equal(isLocallyScopedHostname("example.com"), false);
});

function lookupAll(hostname: string): Promise<{ error: Error | null; addresses: unknown }> {
  return new Promise((resolve) => {
    publicOnlyLookup(hostname, { all: true }, (error, addresses) => {
      resolve({ error, addresses });
    });
  });
}

test("publicOnlyLookup refuses a name that resolves to a non-public address", async () => {
  const { error } = await lookupAll("localhost");
  assert.ok(error instanceof BlockedDestinationError);
});

test("publicOnlyLookup passes through public addresses in both callback shapes", async () => {
  const all = await lookupAll("8.8.8.8");
  assert.equal(all.error, null);
  assert.deepEqual(all.addresses, [{ address: "8.8.8.8", family: 4 }]);

  const single = await new Promise<{ address: unknown; family: unknown }>((resolve) => {
    publicOnlyLookup("8.8.8.8", { all: false }, (_error, address, family) => {
      resolve({ address, family });
    });
  });
  assert.deepEqual(single, { address: "8.8.8.8", family: 4 });
});

test("fetchPublicHttp never connects to loopback, private or credentialed URLs", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("internal");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  try {
    for (const url of [
      `http://127.0.0.1:${port.toString()}/`,
      `http://[::ffff:127.0.0.1]:${port.toString()}/`,
      `http://localhost:${port.toString()}/`,
      `http://user:pass@example.com/`,
      `ftp://example.com/`,
    ]) {
      await assert.rejects(
        fetchPublicHttp({ url: new URL(url), headers: {}, signal: AbortSignal.timeout(5_000) }),
        BlockedDestinationError,
        url,
      );
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});
