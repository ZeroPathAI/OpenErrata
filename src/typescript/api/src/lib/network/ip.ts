import ipaddr from "ipaddr.js";

function parseClientAddress(clientAddress: string): ipaddr.IPv4 | ipaddr.IPv6 {
  const trimmed = clientAddress.trim();
  const zoneSeparatorIndex = trimmed.indexOf("%");
  const withoutZone = zoneSeparatorIndex === -1 ? trimmed : trimmed.slice(0, zoneSeparatorIndex);
  if (ipaddr.IPv4.isValidFourPartDecimal(withoutZone)) {
    return ipaddr.IPv4.parse(withoutZone);
  }
  if (ipaddr.IPv6.isValid(withoutZone)) {
    const ipv6 = ipaddr.IPv6.parse(withoutZone);
    return ipv6.isIPv4MappedAddress() ? ipv6.toIPv4Address() : ipv6;
  }
  throw new Error(`Client address is not an IP address: ${JSON.stringify(clientAddress)}`);
}

/**
 * Derive the network range a client address belongs to for the per-day
 * IP-range view-credit cap (SPEC §2.10): the /24 for IPv4 (first three
 * octets) and the /48 for IPv6 (first three hextets). IPv4-mapped IPv6
 * addresses count as their IPv4 address.
 *
 * The client address comes from the socket peer or the trusted proxy header
 * (ADDRESS_HEADER), so anything that is not an IP address means the proxy
 * configuration is broken; that throws rather than bucketing such clients
 * together.
 */
export function deriveIpRangePrefix(clientAddress: string): string {
  const address = parseClientAddress(clientAddress);
  if (address instanceof ipaddr.IPv4) {
    return address.octets.slice(0, 3).join(".");
  }
  return address.parts
    .slice(0, 3)
    .map((part) => part.toString(16))
    .join(":");
}
