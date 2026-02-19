-- Public eligibility view (spec §2.10, §3.2)
-- Canonical SQL migration for the derived public-eligibility view.
--
-- An investigation is publicly eligible for public-facing outputs when:
--   - status = COMPLETE, and
--   - contentProvenance = 'SERVER_VERIFIED', OR
--   - corroboration credit count >= 3

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
