ALTER TABLE "Investigation"
  ADD COLUMN "isUpdate" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Investigation"
  ADD COLUMN "parentInvestigationId" TEXT;

ALTER TABLE "Investigation"
  ADD COLUMN "contentDiff" TEXT;

ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_isUpdate_parent_consistency_chk"
  CHECK ("isUpdate" = ("parentInvestigationId" IS NOT NULL));

ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_parent_not_self_chk"
  CHECK (
    "parentInvestigationId" IS NULL OR
    "parentInvestigationId" <> "id"
  );

ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_contentDiff_parent_consistency_chk"
  CHECK (
    ("parentInvestigationId" IS NULL AND "contentDiff" IS NULL) OR
    ("parentInvestigationId" IS NOT NULL AND "contentDiff" IS NOT NULL)
  );

ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_id_postId_key"
  UNIQUE ("id", "postId");

ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_parentInvestigationId_postId_fkey"
  FOREIGN KEY ("parentInvestigationId", "postId")
  REFERENCES "Investigation"("id", "postId")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

CREATE INDEX "Investigation_parentInvestigationId_idx"
  ON "Investigation"("parentInvestigationId");

CREATE INDEX "Investigation_isUpdate_idx"
  ON "Investigation"("isUpdate");

CREATE OR REPLACE FUNCTION "enforce_investigation_parent_semantics"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status "CheckStatus";
  parent_provenance "ContentProvenance";
  parent_checked_at TIMESTAMP(3);
BEGIN
  IF NEW."parentInvestigationId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "status", "contentProvenance", "checkedAt"
  INTO parent_status, parent_provenance, parent_checked_at
  FROM "Investigation"
  WHERE "id" = NEW."parentInvestigationId"
    AND "postId" = NEW."postId";

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Update parent investigation not found on same post (parentInvestigationId=%, postId=%)',
      NEW."parentInvestigationId",
      NEW."postId";
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

CREATE TRIGGER "enforce_investigation_parent_semantics_trigger"
BEFORE INSERT OR UPDATE OF "parentInvestigationId", "postId"
ON "Investigation"
FOR EACH ROW
EXECUTE FUNCTION "enforce_investigation_parent_semantics"();

CREATE OR REPLACE FUNCTION "enforce_referenced_parent_investigation_validity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- If this row is not used as an update parent, there is nothing to enforce.
  IF NOT EXISTS (
    SELECT 1
    FROM "Investigation" child
    WHERE child."parentInvestigationId" = NEW."id"
    LIMIT 1
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW."status" <> 'COMPLETE' THEN
    RAISE EXCEPTION
      'Referenced parent investigation must stay COMPLETE (id=%, status=%)',
      NEW."id",
      NEW."status";
  END IF;

  IF NEW."contentProvenance" <> 'SERVER_VERIFIED' THEN
    RAISE EXCEPTION
      'Referenced parent investigation must stay SERVER_VERIFIED (id=%, contentProvenance=%)',
      NEW."id",
      NEW."contentProvenance";
  END IF;

  IF NEW."checkedAt" IS NULL THEN
    RAISE EXCEPTION
      'Referenced parent investigation must keep checkedAt set (id=%)',
      NEW."id";
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "enforce_referenced_parent_investigation_validity_trigger"
BEFORE UPDATE OF "status", "contentProvenance", "checkedAt"
ON "Investigation"
FOR EACH ROW
EXECUTE FUNCTION "enforce_referenced_parent_investigation_validity"();
