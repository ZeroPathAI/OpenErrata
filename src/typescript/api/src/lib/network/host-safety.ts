import ipaddr from "ipaddr.js";

type IpAddress = ipaddr.IPv4 | ipaddr.IPv6;

/**
 * IPv6 ranges that ipaddr.js still labels "unicast" but that can reach
 * non-public networks. RFC 8215 local-use NAT64 translates into IPv4 space the
 * operator chooses, which may be internal.
 */
const NON_PUBLIC_UNICAST_IPV6_RANGES: [ipaddr.IPv6, number][] = [
  [ipaddr.IPv6.parse("64:ff9b:1::"), 48],
];

/**
 * Whether an address is ordinary public unicast, i.e. safe for the server to
 * connect to on behalf of untrusted input. Everything ipaddr.js classifies as
 * anything other than "unicast" (private, loopback, link-local, multicast,
 * CGNAT, reserved, IPv4-mapped, NAT64, 6to4, Teredo, ...) is rejected; the
 * translation ranges are rejected because they can tunnel to internal IPv4.
 */
export function isPublicUnicastAddress(address: IpAddress): boolean {
  if (address.range() !== "unicast") {
    return false;
  }
  if (address instanceof ipaddr.IPv4) {
    return true;
  }
  return !NON_PUBLIC_UNICAST_IPV6_RANGES.some(([network, prefixLength]) =>
    address.match(network, prefixLength),
  );
}

/**
 * Parse a URL hostname that is an IP literal (`203.0.113.5`, `[2001:db8::1]`,
 * `fe80::1%eth0`). Returns null for DNS names. Only strict dotted-quad IPv4 is
 * accepted; WHATWG URL parsing already canonicalizes shorthand IPv4 forms.
 */
export function parseIpLiteral(hostname: string): IpAddress | null {
  const trimmed = hostname.trim().toLowerCase();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const zoneSeparatorIndex = unbracketed.indexOf("%");
  const candidate =
    zoneSeparatorIndex === -1 ? unbracketed : unbracketed.slice(0, zoneSeparatorIndex);

  if (ipaddr.IPv4.isValidFourPartDecimal(candidate)) {
    return ipaddr.IPv4.parse(candidate);
  }
  if (ipaddr.IPv6.isValid(candidate)) {
    return ipaddr.IPv6.parse(candidate);
  }
  return null;
}

/** Hostnames that resolve on the local machine or link regardless of DNS. */
export function isLocallyScopedHostname(hostname: string): boolean {
  const normalizedHost = hostname.trim().toLowerCase().replace(/\.$/, "");
  return (
    normalizedHost.length === 0 ||
    normalizedHost === "localhost" ||
    normalizedHost.endsWith(".localhost") ||
    normalizedHost.endsWith(".local")
  );
}
