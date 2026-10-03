import type { DbClient } from "$lib/db/client";

/**
 * Count one page view (one `recordViewAndGetStatus` call) against today's UTC
 * day for the reporting extension version. The count is all that is kept —
 * no viewer key, IP, post or time of day (PRIVACY.md) — and it exists to show
 * when an extension line the API still serves has stopped sending traffic.
 */
export async function countExtensionVersionPageView(
  db: DbClient,
  extensionVersion: string,
): Promise<void> {
  // One atomic upsert: concurrent first views of the day cannot race on the key.
  await db.$executeRaw`
    INSERT INTO "ExtensionVersionDailyCount" ("day", "version", "pageViewCount")
    VALUES ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, ${extensionVersion}, 1)
    ON CONFLICT ("day", "version")
    DO UPDATE SET "pageViewCount" = "ExtensionVersionDailyCount"."pageViewCount" + 1
  `;
}
