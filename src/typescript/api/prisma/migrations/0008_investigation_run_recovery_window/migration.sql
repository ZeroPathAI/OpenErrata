-- Separate recovery timing from lease ownership.
-- leaseExpiresAt remains a lock-expiry field for active leases.
-- recoverAfterAt gates external stale-run recovery for PROCESSING runs that
-- currently have no lease owner (for example, after transient worker failure).
ALTER TABLE "InvestigationRun"
ADD COLUMN "recoverAfterAt" TIMESTAMP(3);

CREATE INDEX "InvestigationRun_recoverAfterAt_idx"
ON "InvestigationRun"("recoverAfterAt");
