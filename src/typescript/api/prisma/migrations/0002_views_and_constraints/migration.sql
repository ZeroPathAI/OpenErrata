-- Public eligibility view (spec §2.10, §3.2)
CREATE OR REPLACE VIEW "investigation_public_eligibility" AS
SELECT
  i."id" AS "investigationId",
  (
    i."status" = 'COMPLETE'
    AND (
      i."contentProvenance" = 'SERVER_VERIFIED'
      OR (SELECT COUNT(*) FROM "CorroborationCredit" cc
          WHERE cc."investigationId" = i."id") >= 3
    )
  ) AS "isPubliclyEligible"
FROM "Investigation" i;

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

-- InvestigationRun lease ownership is atomic: both fields present or absent.
ALTER TABLE "InvestigationRun"
  ADD CONSTRAINT "InvestigationRun_lease_pair_consistency_check"
  CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL));
