-- ============================================================================
-- Migration 0026: per-version daily extension page-view counts
-- ============================================================================
--
-- One row per (UTC day, extension version): how many recordViewAndGetStatus
-- calls that version made that day. Nothing else is stored — no viewer key, IP
-- or post (PRIVACY.md). It shows when an extension line the API still serves
-- (the legacy v0 adapter for < 0.4.0) has stopped sending traffic. New table
-- only; there is no data to migrate.

-- CreateTable
CREATE TABLE "ExtensionVersionDailyCount" (
    "day" DATE NOT NULL,
    "version" TEXT NOT NULL,
    "pageViewCount" INTEGER NOT NULL,

    CONSTRAINT "ExtensionVersionDailyCount_pkey" PRIMARY KEY ("day","version")
);

-- Versions are what the API's version gate admits: 1–4 dot-separated numeric
-- components. A row exists only once a view has been counted.
ALTER TABLE "ExtensionVersionDailyCount"
  ADD CONSTRAINT "ExtensionVersionDailyCount_version_format_check"
  CHECK ("version" ~ '^[0-9]{1,5}(\.[0-9]{1,5}){0,3}$'),
  ADD CONSTRAINT "ExtensionVersionDailyCount_page_view_count_positive_check"
  CHECK ("pageViewCount" > 0);
