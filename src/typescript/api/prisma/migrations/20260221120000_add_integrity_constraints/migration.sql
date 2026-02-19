-- Tighten representable-valid invariants for investigation lifecycle records.

-- InvestigationAttempt outcomes are now mandatory. Backfill legacy nulls using
-- persisted error rows as the source of truth.
UPDATE "InvestigationAttempt" AS ia
SET "outcome" = CASE
  WHEN EXISTS (
    SELECT 1
    FROM "InvestigationAttemptError" AS e
    WHERE e."attemptId" = ia."id"
  ) THEN 'FAILED'::"InvestigationAttemptOutcome"
  ELSE 'SUCCEEDED'::"InvestigationAttemptOutcome"
END
WHERE ia."outcome" IS NULL;

ALTER TABLE "InvestigationAttempt"
  ALTER COLUMN "outcome" SET NOT NULL;

-- Provenance-specific fields must be internally consistent.
ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_content_provenance_consistency_check"
  CHECK (
    (
      "contentProvenance" = 'SERVER_VERIFIED'
      AND "serverVerifiedAt" IS NOT NULL
      AND "fetchFailureReason" IS NULL
    )
    OR
    (
      "contentProvenance" = 'CLIENT_FALLBACK'
      AND "serverVerifiedAt" IS NULL
    )
  );

-- InvestigationRun lease ownership is atomic: both fields are present or absent.
ALTER TABLE "InvestigationRun"
  ADD CONSTRAINT "InvestigationRun_lease_pair_consistency_check"
  CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL));
