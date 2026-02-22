import { promises as dns } from "node:dns";
import net from "node:net";

type IpFamily = 4 | 6;

type ResolvedAddress = {
  address: string;
  family: IpFamily;
};

function parseIpv4Segments(ipAddress: string): number[] | null {
  const segments = ipAddress.split(".").map((segment) => Number.parseInt(segment, 10));
  if (segments.length !== 4 || segments.some((segment) => Number.isNaN(segment))) {
    return null;
  }
  if (segments.some((segment) => segment < 0 || segment > 255)) {
    return null;
  }
  return segments;
}

function isPrivateIPv4(ipAddress: string): boolean {
  const segments = parseIpv4Segments(ipAddress);
  if (!segments) return false;

  const [a, b, c] = segments;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 240) return true;
  return false;
}

function parseMappedIpv4Address(embeddedIpv4: string): string | null {
  if (embeddedIpv4.includes(".")) {
    return parseIpv4Segments(embeddedIpv4) ? embeddedIpv4 : null;
  }

  const parts = embeddedIpv4.split(":");
  if (parts.length !== 2) return null;
  const upper = Number.parseInt(parts[0] ?? "", 16);
  const lower = Number.parseInt(parts[1] ?? "", 16);
  if (
    !Number.isFinite(upper) ||
    !Number.isFinite(lower) ||
    upper < 0 ||
    upper > 0xffff ||
    lower < 0 ||
    lower > 0xffff
  ) {
    return null;
  }

  const octets = [
    (upper >> 8) & 0xff,
    upper & 0xff,
    (lower >> 8) & 0xff,
    lower & 0xff,
  ];
  return octets.join(".");
}

function isPrivateIPv6(ipAddress: string): boolean {
  const normalized = ipAddress.trim().toLowerCase();
  if (normalized === "::") return true;
  if (normalized.startsWith("::ffff:")) {
    const embeddedIpv4 = normalized.slice("::ffff:".length);
    const mappedIpv4 = parseMappedIpv4Address(embeddedIpv4);
    return mappedIpv4 ? isPrivateIPv4(mappedIpv4) : true;
  }
  if (normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

  const firstHextetRaw = normalized.split(":")[0];
  const firstHextet = firstHextetRaw ? Number.parseInt(firstHextetRaw, 16) : Number.NaN;
  if (
    Number.isFinite(firstHextet) &&
    firstHextet >= 0xfe80 &&
    firstHextet <= 0xfebf
  ) {
    return true;
  }

  return false;
}

export function isPrivateIpAddress(hostnameOrIp: string): boolean {
  const ipVersion = net.isIP(hostnameOrIp);
  if (ipVersion === 4) return isPrivateIPv4(hostnameOrIp);
  if (ipVersion === 6) return isPrivateIPv6(hostnameOrIp);
  return false;
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export async function resolveHostAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const normalizedHost = hostname.trim().toLowerCase();
  const ipVersion = net.isIP(normalizedHost);
  if (ipVersion === 4 || ipVersion === 6) {
    return [{ address: normalizedHost, family: ipVersion }];
  }

  const resolvedAddresses = await dns.lookup(normalizedHost, {
    all: true,
    verbatim: true,
  });
  const deduped = new Map<string, ResolvedAddress>();
  for (const resolved of resolvedAddresses) {
    if (resolved.family !== 4 && resolved.family !== 6) continue;
    const normalizedAddress = normalizeAddress(resolved.address);
    deduped.set(normalizedAddress, {
      address: normalizedAddress,
      family: resolved.family,
    });
  }

  return Array.from(deduped.values());
}

function isLocallyScopedHostname(normalizedHost: string): boolean {
  return (
    normalizedHost === "localhost" ||
    normalizedHost.endsWith(".localhost") ||
    normalizedHost.endsWith(".local")
  );
}

export async function resolvePublicHostAddresses(
  hostname: string,
): Promise<string[] | null> {
  const normalizedHost = hostname.trim().toLowerCase();
  if (normalizedHost.length === 0 || isLocallyScopedHostname(normalizedHost)) {
    return null;
  }

  if (isPrivateIpAddress(normalizedHost)) {
    return null;
  }

  const resolvedAddresses = await resolveHostAddresses(normalizedHost);
  if (resolvedAddresses.length === 0) {
    return null;
  }
  if (resolvedAddresses.some((resolved) => isPrivateIpAddress(resolved.address))) {
    return null;
  }

  return resolvedAddresses.map((resolved) => resolved.address);
}

export function hasAddressIntersection(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right.map(normalizeAddress));
  return left.some((address) => rightSet.has(normalizeAddress(address)));
}

export async function isBlockedHost(hostname: string): Promise<boolean> {
  const normalizedHost = hostname.trim().toLowerCase();

  if (isLocallyScopedHostname(normalizedHost)) {
    return true;
  }

  if (isPrivateIpAddress(normalizedHost)) return true;

  const resolvedAddresses = await resolveHostAddresses(normalizedHost);
  return resolvedAddresses.some((resolved) => isPrivateIpAddress(resolved.address));
}
