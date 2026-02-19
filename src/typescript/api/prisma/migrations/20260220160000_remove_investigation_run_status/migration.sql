DROP INDEX IF EXISTS "InvestigationRun_status_leaseExpiresAt_idx";

ALTER TABLE "InvestigationRun"
  DROP COLUMN "status",
  DROP COLUMN "completedAt";

CREATE INDEX "InvestigationRun_leaseExpiresAt_idx" ON "InvestigationRun"("leaseExpiresAt");
