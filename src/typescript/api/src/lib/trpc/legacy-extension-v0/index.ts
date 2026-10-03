/**
 * Legacy v0 extension protocol adapter (time-boxed).
 *
 * Purpose: extensions older than 0.4.0 speak the extension API as it was at
 * commit 9ee2cae — strict response schemas without investigation ids, no
 * FAILED status from `recordViewAndGetStatus`, and `observedImageUrls` in
 * `registerObservedVersion` inputs. Store installs auto-update, but manual
 * installs from GitHub Releases may not; this adapter keeps them working
 * without a single legacy branch in the current procedures.
 *
 * Serves: extension versions >= 0.2.0 and < 0.4.0 (the
 * `x-openerrata-extension-version` header). 0.4.0 and newer pass through
 * untouched; versions below 0.2.0 are refused by the version gate before
 * reaching this middleware.
 *
 * How: it runs after the version gate and before input parsing. For a legacy
 * request it parses the raw input with the vendored legacy schema
 * (`wire-schemas.ts`), converts it to the current input, runs the current
 * procedure, and converts the current output to the legacy one, validated
 * against the vendored legacy output schema (`procedures.ts` documents each
 * mapping, including the lossy ones). Anything not representable fails loudly.
 *
 * Retirement: on 2026-12-01, or once the version counts
 * (`ExtensionVersionDailyCount`, see the README runbook) show zero 0.3.x
 * requests for 14 consecutive days, whichever is later. Then delete this
 * directory, its `.concat()` in `routes/post.ts` and its integration tests, and
 * raise MINIMUM_SUPPORTED_EXTENSION_VERSION to "0.4.0".
 */

import { initTRPC, TRPCError } from "@trpc/server";
import { isExtensionVersionAtLeast, type ExtensionApiProcedurePath } from "@openerrata/shared";
import { LEGACY_PROCEDURE_ADAPTERS } from "./procedures.js";

/** Oldest version served (the version gate's minimum). */
const OLDEST_LEGACY_EXTENSION_VERSION = "0.2.0";
/** First version that speaks the current protocol. */
export const FIRST_CURRENT_PROTOCOL_EXTENSION_VERSION = "0.4.0";

function speaksLegacyProtocol(extensionVersion: string): boolean {
  const atLeastOldest = isExtensionVersionAtLeast(
    extensionVersion,
    OLDEST_LEGACY_EXTENSION_VERSION,
  );
  const atLeastCurrent = isExtensionVersionAtLeast(
    extensionVersion,
    FIRST_CURRENT_PROTOCOL_EXTENSION_VERSION,
  );
  if (atLeastOldest !== true || atLeastCurrent === null) {
    // The version gate admits only well-formed versions at or above its minimum.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Extension version ${extensionVersion} passed the version gate but predates the legacy protocol floor ${OLDEST_LEGACY_EXTENSION_VERSION}`,
    });
  }
  return !atLeastCurrent;
}

function isExtensionApiProcedurePath(path: string): path is ExtensionApiProcedurePath {
  return Object.hasOwn(LEGACY_PROCEDURE_ADAPTERS, path);
}

/**
 * Procedure-builder fragment holding the adapter middleware; extension
 * procedures `.concat()` it right after the version gate, whose validated
 * `extensionVersion` it reads.
 */
export const legacyExtensionV0Adapter = initTRPC
  .context<{ extensionVersion: string }>()
  .create()
  .procedure.use(async ({ ctx, path, getRawInput, next }) => {
    if (!speaksLegacyProtocol(ctx.extensionVersion)) {
      return next();
    }
    if (!isExtensionApiProcedurePath(path)) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `No legacy v0 extension adapter for procedure ${path}`,
      });
    }
    const adapter = LEGACY_PROCEDURE_ADAPTERS[path];
    const currentRawInput = adapter.toCurrentRawInput(await getRawInput());
    const result = await next({ getRawInput: () => Promise.resolve(currentRawInput) });
    if (!result.ok) {
      return result;
    }
    return { ...result, data: adapter.toLegacyRawOutput(result.data) };
  });
