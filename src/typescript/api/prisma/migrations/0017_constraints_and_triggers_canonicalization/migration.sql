-- Canonicalize post-version and update-lineage invariants.
-- Migration 0016 added partial/duplicate checks; keep one canonical object per invariant.

ALTER TABLE "PostVersion"
  DROP CONSTRAINT IF EXISTS "PostVersion_server_verified_reason_chk",
  DROP CONSTRAINT IF EXISTS "PostVersion_server_verified_at_chk",
  DROP CONSTRAINT IF EXISTS "PostVersion_content_provenance_consistency_check";

ALTER TABLE "PostVersion"
  ADD CONSTRAINT "PostVersion_content_provenance_consistency_check"
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
      AND "fetchFailureReason" IS NOT NULL
      AND LENGTH(BTRIM("fetchFailureReason")) > 0
    )
  );

ALTER TABLE "Investigation"
  DROP CONSTRAINT IF EXISTS "Investigation_content_diff_parent_chk",
  DROP CONSTRAINT IF EXISTS "Investigation_contentDiff_parent_consistency_chk";

ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_contentDiff_parent_consistency_chk"
  CHECK (
    ("parentInvestigationId" IS NULL AND "contentDiff" IS NULL) OR
    ("parentInvestigationId" IS NOT NULL AND "contentDiff" IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION "enforce_investigation_parent_semantics"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status "CheckStatus";
  parent_checked_at TIMESTAMP(3);
  parent_post_id TEXT;
  parent_provenance "ContentProvenance";
  child_post_id TEXT;
BEGIN
  IF NEW."parentInvestigationId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT
    parent_i."status",
    parent_i."checkedAt",
    parent_pv."postId",
    parent_pv."contentProvenance"
  INTO
    parent_status,
    parent_checked_at,
    parent_post_id,
    parent_provenance
  FROM "Investigation" parent_i
  JOIN "PostVersion" parent_pv
    ON parent_pv."id" = parent_i."postVersionId"
  WHERE parent_i."id" = NEW."parentInvestigationId";

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Update parent investigation not found (parentInvestigationId=%)',
      NEW."parentInvestigationId";
  END IF;

  SELECT child_pv."postId"
  INTO child_post_id
  FROM "PostVersion" child_pv
  WHERE child_pv."id" = NEW."postVersionId";

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Child investigation postVersion not found (postVersionId=%)',
      NEW."postVersionId";
  END IF;

  IF parent_post_id <> child_post_id THEN
    RAISE EXCEPTION
      'Update parent investigation must belong to same post (parentInvestigationId=%, childPostVersionId=%)',
      NEW."parentInvestigationId",
      NEW."postVersionId";
  END IF;

  IF parent_status <> 'COMPLETE' THEN
    RAISE EXCEPTION
      'Update parent investigation must be COMPLETE (parentInvestigationId=%, status=%)',
      NEW."parentInvestigationId",
      parent_status;
  END IF;

  IF parent_provenance <> 'SERVER_VERIFIED' THEN
    RAISE EXCEPTION
      'Update parent investigation must be SERVER_VERIFIED (parentInvestigationId=%, contentProvenance=%)',
      NEW."parentInvestigationId",
      parent_provenance;
  END IF;

  IF parent_checked_at IS NULL THEN
    RAISE EXCEPTION
      'Update parent investigation must have checkedAt set (parentInvestigationId=%)',
      NEW."parentInvestigationId";
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_referenced_parent_investigation_validity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_post_id TEXT;
  parent_provenance "ContentProvenance";
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "Investigation" child
    WHERE child."parentInvestigationId" = NEW."id"
    LIMIT 1
  ) THEN
    RETURN NEW;
  END IF;

  SELECT pv."postId", pv."contentProvenance"
  INTO parent_post_id, parent_provenance
  FROM "PostVersion" pv
  WHERE pv."id" = NEW."postVersionId";

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Referenced parent investigation must have a valid postVersion (id=%)',
      NEW."id";
  END IF;

  IF NEW."status" <> 'COMPLETE' THEN
    RAISE EXCEPTION
      'Referenced parent investigation must stay COMPLETE (id=%, status=%)',
      NEW."id",
      NEW."status";
  END IF;

  IF NEW."checkedAt" IS NULL THEN
    RAISE EXCEPTION
      'Referenced parent investigation must keep checkedAt set (id=%)',
      NEW."id";
  END IF;

  IF parent_provenance <> 'SERVER_VERIFIED' THEN
    RAISE EXCEPTION
      'Referenced parent investigation must stay SERVER_VERIFIED (id=%, contentProvenance=%)',
      NEW."id",
      parent_provenance;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Investigation" child
    JOIN "PostVersion" child_pv
      ON child_pv."id" = child."postVersionId"
    WHERE child."parentInvestigationId" = NEW."id"
      AND child_pv."postId" <> parent_post_id
    LIMIT 1
  ) THEN
    RAISE EXCEPTION
      'Referenced parent investigation must stay on same post as all child updates (id=%)',
      NEW."id";
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_referenced_parent_post_version_validity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."contentProvenance" = 'SERVER_VERIFIED' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "Investigation" parent_i
    JOIN "Investigation" child_i
      ON child_i."parentInvestigationId" = parent_i."id"
    WHERE parent_i."postVersionId" = NEW."id"
    LIMIT 1
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'PostVersion referenced by parent investigations must remain SERVER_VERIFIED (postVersionId=%)',
    NEW."id";
END;
$$;

DROP TRIGGER IF EXISTS "enforce_investigation_parent_semantics_trigger"
  ON "Investigation";
CREATE TRIGGER "enforce_investigation_parent_semantics_trigger"
BEFORE INSERT OR UPDATE OF "parentInvestigationId", "postVersionId"
ON "Investigation"
FOR EACH ROW
EXECUTE FUNCTION "enforce_investigation_parent_semantics"();

DROP TRIGGER IF EXISTS "enforce_referenced_parent_investigation_validity_trigger"
  ON "Investigation";
CREATE TRIGGER "enforce_referenced_parent_investigation_validity_trigger"
BEFORE UPDATE OF "status", "checkedAt", "postVersionId"
ON "Investigation"
FOR EACH ROW
EXECUTE FUNCTION "enforce_referenced_parent_investigation_validity"();

DROP TRIGGER IF EXISTS "enforce_referenced_parent_post_version_validity_trigger"
  ON "PostVersion";
CREATE TRIGGER "enforce_referenced_parent_post_version_validity_trigger"
BEFORE UPDATE OF "contentProvenance"
ON "PostVersion"
FOR EACH ROW
EXECUTE FUNCTION "enforce_referenced_parent_post_version_validity"();
