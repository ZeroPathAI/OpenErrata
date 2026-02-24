-- COMPLETE rows must always carry completion timestamps.
UPDATE "Investigation"
SET "checkedAt" = COALESCE("checkedAt", "updatedAt")
WHERE "status" = 'COMPLETE'
  AND "checkedAt" IS NULL;

-- Non-COMPLETE rows must not carry completion timestamps.
UPDATE "Investigation"
SET "checkedAt" = NULL
WHERE "status" <> 'COMPLETE'
  AND "checkedAt" IS NOT NULL;

-- CLIENT_FALLBACK rows must always include a failure reason.
UPDATE "Investigation"
SET "fetchFailureReason" = COALESCE("fetchFailureReason", 'Canonical server fetch unavailable')
WHERE "contentProvenance" = 'CLIENT_FALLBACK'
  AND "fetchFailureReason" IS NULL;

ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_checked_at_consistency_check"
  CHECK (
    (
      "status" = 'COMPLETE'
      AND "checkedAt" IS NOT NULL
    )
    OR
    (
      "status" <> 'COMPLETE'
      AND "checkedAt" IS NULL
    )
  );

ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_client_fallback_reason_check"
  CHECK (
    (
      "contentProvenance" = 'SERVER_VERIFIED'
      AND "fetchFailureReason" IS NULL
    )
    OR
    (
      "contentProvenance" = 'CLIENT_FALLBACK'
      AND "fetchFailureReason" IS NOT NULL
    )
  );
