import { isIP } from "node:net";

type Ipv4Octets = [number, number, number, number];

function parseIpv4Octets(value: string): Ipv4Octets | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  const parsedOctets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    const parsed = Number.parseInt(part, 10);
    return parsed >= 0 && parsed <= 255 ? parsed : Number.NaN;
  });

  if (parsedOctets.some((octet) => Number.isNaN(octet))) return null;

  const [a, b, c, d] = parsedOctets;
  return [a, b, c, d];
}

function ipv4Prefix(octets: number[]): string {
  return octets.slice(0, 3).join(".");
}

function isValidHextet(hextet: string): boolean {
  return /^[0-9a-f]{1,4}$/i.test(hextet);
}

function normalizeHextet(hextet: string): string {
  return Number.parseInt(hextet, 16).toString(16);
}

function expandIpv6(input: string): string[] | null {
  let address = input.trim().toLowerCase();

  const zoneIndex = address.indexOf("%");
  if (zoneIndex >= 0) {
    address = address.slice(0, zoneIndex);
  }

  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    if (lastColon < 0) return null;

    const ipv4Part = address.slice(lastColon + 1);
    const octets = parseIpv4Octets(ipv4Part);
    if (!octets) return null;

    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    address = `${address.slice(0, lastColon)}:${high}:${low}`;
  }

  const parts = address.split("::");
  if (parts.length > 2) return null;

  const left = parts[0]
    ? parts[0].split(":").filter((part) => part.length > 0)
    : [];
  const right =
    parts.length === 2 && parts[1]
      ? parts[1].split(":").filter((part) => part.length > 0)
      : [];

  if (!left.every(isValidHextet) || !right.every(isValidHextet)) {
    return null;
  }

  const missing = 8 - (left.length + right.length);
  if (parts.length === 1 && missing !== 0) return null;
  if (parts.length === 2 && missing < 1) return null;

  const expanded = [
    ...left,
    ...(parts.length === 2 ? Array.from({ length: missing }, () => "0") : []),
    ...right,
  ].map(normalizeHextet);

  return expanded.length === 8 ? expanded : null;
}

function mappedIpv4FromIpv6(expandedIpv6: string[]): Ipv4Octets | null {
  const mappedMarker = expandedIpv6[5];
  const highHextet = expandedIpv6[6];
  const lowHextet = expandedIpv6[7];
  if (!mappedMarker || !highHextet || !lowHextet) return null;

  const isMappedPrefix =
    expandedIpv6.slice(0, 5).every((hextet) => hextet === "0") &&
    mappedMarker === "ffff";
  if (!isMappedPrefix) return null;

  const high = Number.parseInt(highHextet, 16);
  const low = Number.parseInt(lowHextet, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function ipv6Prefix(expandedIpv6: string[]): string {
  return expandedIpv6.slice(0, 3).join(":");
}

export function deriveIpRangePrefix(clientIp: string): string {
  const trimmed = clientIp.trim();
  if (trimmed.length === 0) return "unknown";

  const ipv4 = parseIpv4Octets(trimmed);
  if (ipv4) {
    return ipv4Prefix(ipv4);
  }

  if (isIP(trimmed) === 6) {
    const expanded = expandIpv6(trimmed);
    if (!expanded) return `invalid:${trimmed.toLowerCase()}`;

    const mappedIpv4 = mappedIpv4FromIpv6(expanded);
    if (mappedIpv4) {
      return ipv4Prefix(mappedIpv4);
    }
    return ipv6Prefix(expanded);
  }

  return `invalid:${trimmed.toLowerCase()}`;
}
