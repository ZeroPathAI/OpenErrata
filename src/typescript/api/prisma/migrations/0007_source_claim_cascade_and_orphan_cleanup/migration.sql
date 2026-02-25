-- Sources are owned by their parent Claim and should cascade-delete with it.
-- The original FK was restrictive, which caused Source_claimId_fkey violations
-- when the orchestrator tried to delete claims that still had sources.
ALTER TABLE "Source" DROP CONSTRAINT "Source_claimId_fkey";
ALTER TABLE "Source" ADD CONSTRAINT "Source_claimId_fkey"
  FOREIGN KEY ("claimId") REFERENCES "Claim"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Clean up orphaned claims on FAILED investigations.
-- A race condition between concurrent workers could write claims and then
-- overwrite COMPLETE -> FAILED, leaving claims on a FAILED investigation.
-- Sources cascade-delete automatically with the new FK above.
DELETE FROM "Claim" WHERE "investigationId" IN (
  SELECT "id" FROM "Investigation" WHERE "status" = 'FAILED'
);
