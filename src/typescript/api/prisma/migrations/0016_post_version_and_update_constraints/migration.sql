ALTER TABLE "PostVersion"
  ADD CONSTRAINT "PostVersion_server_verified_reason_chk"
  CHECK (
    "contentProvenance" <> 'SERVER_VERIFIED' OR
    "fetchFailureReason" IS NULL
  );

ALTER TABLE "PostVersion"
  ADD CONSTRAINT "PostVersion_server_verified_at_chk"
  CHECK (
    "contentProvenance" <> 'SERVER_VERIFIED' OR
    "serverVerifiedAt" IS NOT NULL
  );

ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_content_diff_parent_chk"
  CHECK (
    ("parentInvestigationId" IS NULL AND "contentDiff" IS NULL) OR
    ("parentInvestigationId" IS NOT NULL AND "contentDiff" IS NOT NULL)
  );
