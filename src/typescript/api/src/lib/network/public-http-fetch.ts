/**
 * HTTP(S) fetching of URLs chosen by untrusted input (post image URLs from
 * anonymous clients, URLs the model asks `fetch_url` to read).
 *
 * The SSRF check lives on the connection itself: every connection goes through
 * an undici Agent whose DNS lookup rejects the whole answer if any resolved
 * address is not public unicast, and hands the socket only the addresses it
 * validated. A hostname that rebinds between "check" and "connect" therefore
 * has nothing to rebind into — there is no separate check. IP-literal hosts
 * never reach DNS, so they are validated before dispatch. Redirects are
 * followed manually so every hop goes through the same agent.
 */

import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch, type Response } from "undici";
import { isLocallyScopedHostname, isPublicUnicastAddress, parseIpLiteral } from "./host-safety.js";
import { isRedirectStatus } from "./http-status.js";

const MAX_REDIRECT_HOPS = 5;

export class BlockedDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedDestinationError";
  }
}

class PublicHttpFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicHttpFetchError";
  }
}

function nonPublicAddresses(addresses: LookupAddress[]): string[] {
  return addresses
    .filter((resolved) => !isPublicUnicastAddress(ipaddr.parse(resolved.address)))
    .map((resolved) => resolved.address);
}

/**
 * DNS lookup for the public-internet agent: resolves like dns.lookup but fails
 * with BlockedDestinationError unless every address is public unicast, and
 * returns only addresses it checked. Exported for unit tests.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options: LookupOptions, callback) => {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error !== null) {
      callback(error, "", 0);
      return;
    }
    const [first] = addresses;
    if (first === undefined) {
      callback(new BlockedDestinationError(`${hostname} did not resolve to any address`), "", 0);
      return;
    }
    const blocked = nonPublicAddresses(addresses);
    if (blocked.length > 0) {
      callback(
        new BlockedDestinationError(
          `${hostname} resolves to non-public address(es): ${blocked.join(", ")}`,
        ),
        "",
        0,
      );
      return;
    }
    if (options.all === true) {
      callback(null, addresses);
      return;
    }
    callback(null, first.address, first.family);
  });
};

const publicInternetAgent = new Agent({ connect: { lookup: publicOnlyLookup } });

function assertFetchableUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedDestinationError(`Only HTTP(S) URLs are allowed (got ${url.protocol})`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new BlockedDestinationError("URLs with embedded credentials are not allowed");
  }
  if (isLocallyScopedHostname(url.hostname)) {
    throw new BlockedDestinationError(`Blocked local hostname ${url.hostname}`);
  }
  const literal = parseIpLiteral(url.hostname);
  if (literal !== null && !isPublicUnicastAddress(literal)) {
    throw new BlockedDestinationError(`Blocked non-public address ${url.hostname}`);
  }
}

interface PublicHttpResponse {
  /** URL of the final (non-redirect) response. */
  finalUrl: URL;
  response: Response;
}

/**
 * GET `url` from the public internet, following up to MAX_REDIRECT_HOPS
 * redirects. Throws BlockedDestinationError when any hop targets a non-public
 * destination and PublicHttpFetchError for malformed redirect chains; network
 * errors and aborts propagate as thrown by undici.
 */
export async function fetchPublicHttp(input: {
  url: URL;
  headers: Record<string, string>;
  signal: AbortSignal;
}): Promise<PublicHttpResponse> {
  let currentUrl = input.url;
  for (let redirectHop = 0; redirectHop <= MAX_REDIRECT_HOPS; redirectHop += 1) {
    assertFetchableUrl(currentUrl);
    const response = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: input.headers,
      signal: input.signal,
      dispatcher: publicInternetAgent,
    });

    if (!isRedirectStatus(response.status)) {
      return { finalUrl: currentUrl, response };
    }

    await response.body?.cancel();
    const location = response.headers.get("location");
    if (location === null || location.length === 0) {
      throw new PublicHttpFetchError("Redirect response missing Location header");
    }
    currentUrl = new URL(location, currentUrl);
  }

  throw new PublicHttpFetchError(`Too many redirects (more than ${MAX_REDIRECT_HOPS.toString()})`);
}

/**
 * Read at most `maxBytes` of a response body, cancelling the stream as soon as
 * the limit is exceeded. `truncated` reports whether any bytes were dropped.
 */
export async function readBodyPrefix(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (response.body === null) {
    return { bytes: new Uint8Array(0), truncated: false };
  }

  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;
  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - totalBytes;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        totalBytes += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
    if (!truncated && totalBytes >= maxBytes) {
      truncated = !(await reader.read()).done;
    }
  } finally {
    if (truncated) {
      await reader.cancel("Response body exceeds byte limit");
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}
