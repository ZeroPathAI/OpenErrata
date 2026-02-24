-- CLIENT_FALLBACK rows must include a meaningful failure reason.
UPDATE "Investigation"
SET "fetchFailureReason" = 'Canonical server fetch unavailable'
WHERE "contentProvenance" = 'CLIENT_FALLBACK'
  AND (
    "fetchFailureReason" IS NULL
    OR btrim("fetchFailureReason") = ''
  );

ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_client_fallback_reason_non_empty_check"
  CHECK (
    "contentProvenance" <> 'CLIENT_FALLBACK'
    OR length(btrim("fetchFailureReason")) > 0
  );
