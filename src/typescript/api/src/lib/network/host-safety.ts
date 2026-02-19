import { promises as dns } from "node:dns";
import net from "node:net";

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

  const [a, b] = segments;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIPv6(ipAddress: string): boolean {
  const normalized = ipAddress.trim().toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const embeddedIpv4 = normalized.slice("::ffff:".length);
    return isPrivateIPv4(embeddedIpv4);
  }
  if (normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }
  return false;
}

function isPrivateIpAddress(hostnameOrIp: string): boolean {
  const ipVersion = net.isIP(hostnameOrIp);
  if (ipVersion === 4) return isPrivateIPv4(hostnameOrIp);
  if (ipVersion === 6) return isPrivateIPv6(hostnameOrIp);
  return false;
}

export async function isBlockedHost(hostname: string): Promise<boolean> {
  const normalizedHost = hostname.trim().toLowerCase();

  if (
    normalizedHost === "localhost" ||
    normalizedHost.endsWith(".localhost") ||
    normalizedHost.endsWith(".local")
  ) {
    return true;
  }

  if (isPrivateIpAddress(normalizedHost)) return true;

  const resolvedAddresses = await dns.lookup(normalizedHost, { all: true });
  return resolvedAddresses.some((resolved) => isPrivateIpAddress(resolved.address));
}
