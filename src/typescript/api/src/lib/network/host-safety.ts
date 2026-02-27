import { promises as dns } from "node:dns";
import ipaddr from "ipaddr.js";

type IpFamily = 4 | 6;

type ResolvedAddress = {
  address: string;
  family: IpFamily;
};

const PRIVATE_IPV4_SUBNETS: Record<string, [ipaddr.IPv4, number] | [ipaddr.IPv4, number][]> = {
  unspecified: [[ipaddr.IPv4.parse("0.0.0.0"), 8]],
  private: [
    [ipaddr.IPv4.parse("10.0.0.0"), 8],
    [ipaddr.IPv4.parse("172.16.0.0"), 12],
    [ipaddr.IPv4.parse("192.168.0.0"), 16],
  ],
  carrierGradeNat: [[ipaddr.IPv4.parse("100.64.0.0"), 10]],
  loopback: [[ipaddr.IPv4.parse("127.0.0.0"), 8]],
  linkLocal: [[ipaddr.IPv4.parse("169.254.0.0"), 16]],
  ietfProtocol: [[ipaddr.IPv4.parse("192.0.0.0"), 24]],
  benchmarking: [[ipaddr.IPv4.parse("198.18.0.0"), 15]],
  reserved: [[ipaddr.IPv4.parse("240.0.0.0"), 4]],
};

function normalizeIpLiteralCandidate(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const zoneSeparatorIndex = withoutBrackets.indexOf("%");
  if (zoneSeparatorIndex === -1) {
    return withoutBrackets;
  }
  return withoutBrackets.slice(0, zoneSeparatorIndex);
}

function parseIpAddress(input: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  const candidate = normalizeIpLiteralCandidate(input);
  if (ipaddr.IPv4.isValidFourPartDecimal(candidate)) {
    return ipaddr.IPv4.parse(candidate);
  }
  if (ipaddr.IPv6.isValid(candidate)) {
    return ipaddr.IPv6.parse(candidate);
  }
  return null;
}

function isIpv4Address(address: ipaddr.IPv4 | ipaddr.IPv6): address is ipaddr.IPv4 {
  return address.kind() === "ipv4";
}

function isPrivateIPv4(address: ipaddr.IPv4): boolean {
  return ipaddr.subnetMatch(address, PRIVATE_IPV4_SUBNETS, "public") !== "public";
}

function isPrivateIPv6(address: ipaddr.IPv6): boolean {
  if (address.isIPv4MappedAddress()) {
    return isPrivateIPv4(address.toIPv4Address());
  }
  const range = address.range();
  return (
    range === "unspecified" ||
    range === "loopback" ||
    range === "uniqueLocal" ||
    range === "linkLocal"
  );
}

export function isPrivateIpAddress(hostnameOrIp: string): boolean {
  const parsedAddress = parseIpAddress(hostnameOrIp);
  if (!parsedAddress) return false;
  if (isIpv4Address(parsedAddress)) {
    return isPrivateIPv4(parsedAddress);
  }
  return isPrivateIPv6(parsedAddress);
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

async function resolveHostAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const normalizedHost = hostname.trim().toLowerCase();
  const parsedAddress = parseIpAddress(normalizedHost);
  if (parsedAddress) {
    return [
      {
        address: parsedAddress.toNormalizedString(),
        family: parsedAddress.kind() === "ipv4" ? 4 : 6,
      },
    ];
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

export async function resolvePublicHostAddresses(hostname: string): Promise<string[] | null> {
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
