-- Extract InvestigationLease table from InvestigationRun.
--
-- Instead of merging lease fields into Investigation (with CHECK constraints),
-- this migration creates a separate InvestigationLease table where all fields
-- are NOT NULL. The row's existence represents "this investigation is PROCESSING
-- and has a lease holder" — the representable-valid principle is enforced by
-- the schema itself:
--   - Can't have leaseOwner without leaseExpiresAt (both are NOT NULL)
--   - Can't have lease fields on a non-PROCESSING investigation (no row)
--   - progressClaims lives on the lease row — automatically cleaned up on delete

-- ── Phase 1: Create InvestigationLease table ────────────────────────────────

CREATE TABLE "InvestigationLease" (
  "investigationId" TEXT NOT NULL,
  "leaseOwner" TEXT NOT NULL,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "heartbeatAt" TIMESTAMP(3) NOT NULL,
  "progressClaims" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvestigationLease_pkey" PRIMARY KEY ("investigationId"),
  CONSTRAINT "InvestigationLease_investigationId_fkey"
    FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "InvestigationLease_leaseExpiresAt_idx" ON "InvestigationLease"("leaseExpiresAt");

-- ── Phase 2: Backfill from InvestigationRun + Investigation.progressClaims ──

INSERT INTO "InvestigationLease" ("investigationId", "leaseOwner", "leaseExpiresAt", "startedAt", "heartbeatAt", "progressClaims")
SELECT r."investigationId", r."leaseOwner", r."leaseExpiresAt", r."startedAt", r."heartbeatAt", i."progressClaims"
FROM "InvestigationRun" r
JOIN "Investigation" i ON i."id" = r."investigationId"
WHERE r."leaseOwner" IS NOT NULL
  AND r."leaseExpiresAt" IS NOT NULL
  AND i."status" = 'PROCESSING';

-- ── Phase 3: Add queuedAt to Investigation ──────────────────────────────────

ALTER TABLE "Investigation" ADD COLUMN "queuedAt" TIMESTAMP(3);
UPDATE "Investigation" i SET "queuedAt" = r."queuedAt" FROM "InvestigationRun" r WHERE r."investigationId" = i."id";
UPDATE "Investigation" SET "queuedAt" = "createdAt" WHERE "queuedAt" IS NULL;
ALTER TABLE "Investigation" ALTER COLUMN "queuedAt" SET NOT NULL;
ALTER TABLE "Investigation" ALTER COLUMN "queuedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- ── Phase 3b: Add attemptCount to Investigation ─────────────────────────────

ALTER TABLE "Investigation" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;

-- ── Phase 3c: Add retryAfter to Investigation ───────────────────────────────

ALTER TABLE "Investigation" ADD COLUMN "retryAfter" TIMESTAMP(3);

-- ── Phase 4: Re-point InvestigationOpenAiKeySource FK ───────────────────────

ALTER TABLE "InvestigationOpenAiKeySource"
  ADD COLUMN "investigationId" TEXT;

UPDATE "InvestigationOpenAiKeySource" ks
SET "investigationId" = r."investigationId"
FROM "InvestigationRun" r
WHERE r."id" = ks."runId";

ALTER TABLE "InvestigationOpenAiKeySource"
  ALTER COLUMN "investigationId" SET NOT NULL;

ALTER TABLE "InvestigationOpenAiKeySource"
  ADD CONSTRAINT "InvestigationOpenAiKeySource_investigationId_fkey"
  FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Drop old FK and PK
ALTER TABLE "InvestigationOpenAiKeySource"
  DROP CONSTRAINT "InvestigationOpenAiKeySource_runId_fkey";
ALTER TABLE "InvestigationOpenAiKeySource"
  DROP CONSTRAINT "InvestigationOpenAiKeySource_pkey";
ALTER TABLE "InvestigationOpenAiKeySource"
  ADD PRIMARY KEY ("investigationId");
ALTER TABLE "InvestigationOpenAiKeySource"
  DROP COLUMN "runId";

-- ── Phase 5: Fix zombies ────────────────────────────────────────────────────

-- Delete expired leases
DELETE FROM "InvestigationLease" WHERE "leaseExpiresAt" <= NOW();

-- PROCESSING without lease row → PENDING
UPDATE "Investigation" SET "status" = 'PENDING'
WHERE "status" = 'PROCESSING'
  AND "id" NOT IN (SELECT "investigationId" FROM "InvestigationLease");

-- ── Phase 6: Drop progressClaims from Investigation ─────────────────────────

ALTER TABLE "Investigation" DROP COLUMN IF EXISTS "progressClaims";

-- ── Phase 7: Drop InvestigationRun (explicit, no CASCADE) ───────────────────

-- Explicitly drop all known dependencies first so unexpected ones fail loud
ALTER TABLE "InvestigationRun"
  DROP CONSTRAINT IF EXISTS "InvestigationRun_investigationId_fkey";
DROP INDEX IF EXISTS "InvestigationRun_investigationId_key";
DROP INDEX IF EXISTS "InvestigationRun_leaseExpiresAt_idx";
DROP INDEX IF EXISTS "InvestigationRun_recoverAfterAt_idx";
ALTER TABLE "InvestigationRun"
  DROP CONSTRAINT IF EXISTS "InvestigationRun_lease_pair_consistency_check";

-- Now drop the table — will fail if any unexpected FK or dependency remains
DROP TABLE "InvestigationRun";
