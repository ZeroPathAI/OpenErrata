/**
 * Validation of the post URL a client reports to registerObservedVersion.
 *
 * Until a server fetch supplies the canonical URL (SPEC §2.9), the client's
 * URL is what we store and link to publicly, so it must be an https URL on the
 * platform's own host that names the same post as `externalId`. Substack
 * publications may use custom domains, so only the post path is checked there.
 */

import { TRPCError } from "@trpc/server";
import type { PreparedViewPostInput } from "../wikipedia.js";

const LESSWRONG_HOSTS: ReadonlySet<string> = new Set(["lesswrong.com", "www.lesswrong.com"]);
const X_HOSTS = ["x.com", "twitter.com"] as const;

function isXHost(hostname: string): boolean {
  return X_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/** Status id named by an X status path (`/<handle>/status/<id>`, `/i/status/<id>`, `/i/web/status/<id>`). */
function xStatusIdFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const statusIndex = segments.indexOf("status");
  if (statusIndex < 1) return null;
  return segments[statusIndex + 1] ?? null;
}

function lesswrongPathNamesPost(pathname: string, externalId: string): boolean {
  const prefix = `/posts/${externalId}`;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function rejectUrl(platform: string, reason: string): never {
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: `Invalid ${platform} post URL: ${reason}`,
  });
}

export function assertObservedPostUrlMatchesPlatform(input: PreparedViewPostInput): void {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return rejectUrl(input.platform, "not a URL");
  }
  if (url.protocol !== "https:") {
    rejectUrl(input.platform, "must use https");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    rejectUrl(input.platform, "must not embed credentials");
  }
  const hostname = url.hostname.toLowerCase();

  switch (input.platform) {
    case "LESSWRONG":
      if (!LESSWRONG_HOSTS.has(hostname)) {
        rejectUrl(input.platform, `unexpected host ${hostname}`);
      }
      if (!lesswrongPathNamesPost(url.pathname, input.externalId)) {
        rejectUrl(input.platform, "path does not name the post's externalId");
      }
      return;
    case "X":
      if (!isXHost(hostname)) {
        rejectUrl(input.platform, `unexpected host ${hostname}`);
      }
      if (xStatusIdFromPath(url.pathname) !== input.externalId) {
        rejectUrl(input.platform, "path does not name the post's externalId");
      }
      return;
    case "SUBSTACK":
      if (!/^\/p\/[^/]+/.test(url.pathname)) {
        rejectUrl(input.platform, "path is not a /p/<slug> post path");
      }
      return;
    case "WIKIPEDIA":
      // Host and article identity are checked against metadata when the
      // external ID is derived (prepareViewPostInput).
      return;
  }
}
