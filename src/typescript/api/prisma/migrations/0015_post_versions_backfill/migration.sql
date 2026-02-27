-- Normalize legacy post/investigation content into versioned tables.
-- This migration introduces PostVersion + supporting blobs/occurrence tables,
-- backfills existing rows, and rewires Investigation to postVersionId.
--
-- We rely on pgcrypto for SHA-256 hashing so migrated version identifiers
-- match runtime identity formulas exactly.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- New normalized content tables.
CREATE TABLE "ContentBlob" (
  "id" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "contentText" TEXT NOT NULL,
  "wordCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContentBlob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContentBlob_contentHash_key"
  ON "ContentBlob"("contentHash");

CREATE TABLE "ImageOccurrenceSet" (
  "id" TEXT NOT NULL,
  "occurrencesHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ImageOccurrenceSet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImageOccurrenceSet_occurrencesHash_key"
  ON "ImageOccurrenceSet"("occurrencesHash");

CREATE TABLE "ImageOccurrence" (
  "id" TEXT NOT NULL,
  "occurrenceSetId" TEXT NOT NULL,
  "originalIndex" INTEGER NOT NULL,
  "normalizedTextOffset" INTEGER NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "captionText" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ImageOccurrence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImageOccurrence_occurrenceSetId_originalIndex_key"
  ON "ImageOccurrence"("occurrenceSetId", "originalIndex");

CREATE INDEX "ImageOccurrence_occurrenceSetId_normalizedTextOffset_origin_idx"
  ON "ImageOccurrence"("occurrenceSetId", "normalizedTextOffset", "originalIndex");

ALTER TABLE "ImageOccurrence"
  ADD CONSTRAINT "ImageOccurrence_occurrenceSetId_fkey"
  FOREIGN KEY ("occurrenceSetId") REFERENCES "ImageOccurrenceSet"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PostVersion" (
  "id" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "versionHash" TEXT NOT NULL,
  "contentBlobId" TEXT NOT NULL,
  "imageOccurrenceSetId" TEXT NOT NULL,
  "contentProvenance" "ContentProvenance" NOT NULL,
  "fetchFailureReason" TEXT,
  "serverVerifiedAt" TIMESTAMP(3),
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "seenCount" INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT "PostVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PostVersion_postId_versionHash_key"
  ON "PostVersion"("postId", "versionHash");

CREATE UNIQUE INDEX "PostVersion_postId_contentBlobId_imageOccurrenceSetId_key"
  ON "PostVersion"("postId", "contentBlobId", "imageOccurrenceSetId");

CREATE INDEX "PostVersion_postId_lastSeenAt_idx"
  ON "PostVersion"("postId", "lastSeenAt");

CREATE INDEX "PostVersion_postId_contentProvenance_lastSeenAt_idx"
  ON "PostVersion"("postId", "contentProvenance", "lastSeenAt");

ALTER TABLE "PostVersion"
  ADD CONSTRAINT "PostVersion_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "Post"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PostVersion"
  ADD CONSTRAINT "PostVersion_contentBlobId_fkey"
  FOREIGN KEY ("contentBlobId") REFERENCES "ContentBlob"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PostVersion"
  ADD CONSTRAINT "PostVersion_imageOccurrenceSetId_fkey"
  FOREIGN KEY ("imageOccurrenceSetId") REFERENCES "ImageOccurrenceSet"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PostVersionViewCredit" (
  "id" TEXT NOT NULL,
  "postVersionId" TEXT NOT NULL,
  "viewerKey" TEXT NOT NULL,
  "ipRangeKey" TEXT NOT NULL,
  "bucketDay" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PostVersionViewCredit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PostVersionViewCredit_postVersionId_viewerKey_bucketDay_key"
  ON "PostVersionViewCredit"("postVersionId", "viewerKey", "bucketDay");

CREATE INDEX "PostVersionViewCredit_postVersionId_bucketDay_idx"
  ON "PostVersionViewCredit"("postVersionId", "bucketDay");

CREATE INDEX "PostVersionViewCredit_postVersionId_ipRangeKey_bucketDay_idx"
  ON "PostVersionViewCredit"("postVersionId", "ipRangeKey", "bucketDay");

ALTER TABLE "PostVersionViewCredit"
  ADD CONSTRAINT "PostVersionViewCredit_postVersionId_fkey"
  FOREIGN KEY ("postVersionId") REFERENCES "PostVersion"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Assemble a single source-of-truth set of legacy versions.
-- Investigation rows define authoritative historical versions. If a post has
-- cached content but no investigation yet, migrate that cache into a version so
-- we do not silently discard known content state.
CREATE TEMP TABLE "_legacy_version_source" AS
WITH investigation_versions AS (
  SELECT DISTINCT ON (i."postId", i."contentHash")
    i."postId",
    i."contentHash",
    i."contentText",
    i."contentProvenance",
    i."fetchFailureReason",
    i."serverVerifiedAt",
    i."createdAt" AS "firstSeenAt",
    GREATEST(i."createdAt", COALESCE(i."checkedAt", i."updatedAt", i."createdAt")) AS "lastSeenAt",
    1::INTEGER AS "seenCount"
  FROM "Investigation" i
  ORDER BY i."postId", i."contentHash", i."createdAt", i."id"
),
post_cache_versions AS (
  SELECT
    p."id" AS "postId",
    p."latestContentHash" AS "contentHash",
    p."latestContentText" AS "contentText",
    CASE
      WHEN p."latestServerVerifiedContentHash" = p."latestContentHash"
        THEN 'SERVER_VERIFIED'::"ContentProvenance"
      ELSE 'CLIENT_FALLBACK'::"ContentProvenance"
    END AS "contentProvenance",
    CASE
      WHEN p."latestServerVerifiedContentHash" = p."latestContentHash"
        THEN NULL
      ELSE 'Migrated from legacy post cache without canonical verification'
    END AS "fetchFailureReason",
    CASE
      WHEN p."latestServerVerifiedContentHash" = p."latestContentHash"
        THEN COALESCE(p."lastViewedAt", p."updatedAt", p."createdAt")
      ELSE NULL
    END AS "serverVerifiedAt",
    p."createdAt" AS "firstSeenAt",
    COALESCE(p."lastViewedAt", p."updatedAt", p."createdAt") AS "lastSeenAt",
    GREATEST(p."viewCount", 1)::INTEGER AS "seenCount"
  FROM "Post" p
  WHERE p."latestContentHash" IS NOT NULL
    AND p."latestContentText" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM investigation_versions iv
      WHERE iv."postId" = p."id"
        AND iv."contentHash" = p."latestContentHash"
    )
)
SELECT * FROM investigation_versions
UNION ALL
SELECT * FROM post_cache_versions;

-- Fail fast if legacy data violates ContentBlob uniqueness assumptions.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "_legacy_version_source" s
    GROUP BY s."contentHash"
    HAVING COUNT(DISTINCT s."contentText") > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot migrate legacy data: at least one contentHash maps to multiple contentText values';
  END IF;
END;
$$;

-- Deterministic image-occurrence sets from legacy PostImageOccurrence rows.
-- The hash payload matches runtime:
-- JSON.stringify([{originalIndex,normalizedTextOffset,sourceUrl,captionText?}, ...])
CREATE TEMP TABLE "_legacy_post_occurrence_digest" AS
SELECT
  p."postId",
  COALESCE(
    (
      SELECT
        '[' || STRING_AGG(
          '{"originalIndex":' || pio."originalIndex"::TEXT ||
          ',"normalizedTextOffset":' || pio."normalizedTextOffset"::TEXT ||
          ',"sourceUrl":' || TO_JSON(pio."sourceUrl")::TEXT ||
          CASE
            WHEN pio."captionText" IS NULL OR LENGTH(BTRIM(pio."captionText")) = 0
              THEN ''
            ELSE ',"captionText":' || TO_JSON(BTRIM(pio."captionText"))::TEXT
          END ||
          '}',
          ',' ORDER BY pio."originalIndex"
        ) || ']'
      FROM "PostImageOccurrence" pio
      WHERE pio."postId" = p."postId"
    ),
    '[]'
  ) AS "occurrencesJson"
FROM (
  SELECT DISTINCT s."postId"
  FROM "_legacy_version_source" s
) p;

ALTER TABLE "_legacy_post_occurrence_digest"
  ADD COLUMN "occurrencesHash" TEXT;

UPDATE "_legacy_post_occurrence_digest"
SET "occurrencesHash" = ENCODE(DIGEST("occurrencesJson", 'sha256'), 'hex');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "_legacy_post_occurrence_digest" d
    GROUP BY d."occurrencesHash"
    HAVING COUNT(DISTINCT d."occurrencesJson") > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot migrate legacy data: at least one occurrencesHash maps to multiple occurrence payloads';
  END IF;
END;
$$;

CREATE TEMP TABLE "_legacy_occurrence_set_map" AS
SELECT
  h."occurrencesHash",
  ('legacy_ios_' || ROW_NUMBER() OVER (ORDER BY h."occurrencesHash")) AS "imageOccurrenceSetId"
FROM (
  SELECT DISTINCT d."occurrencesHash"
  FROM "_legacy_post_occurrence_digest" d
) h;

CREATE TEMP TABLE "_legacy_post_image_occurrence_set_map" AS
SELECT
  d."postId",
  m."imageOccurrenceSetId",
  d."occurrencesHash"
FROM "_legacy_post_occurrence_digest" d
JOIN "_legacy_occurrence_set_map" m
  ON m."occurrencesHash" = d."occurrencesHash";

INSERT INTO "ImageOccurrenceSet" (
  "id",
  "occurrencesHash"
)
SELECT
  m."imageOccurrenceSetId",
  m."occurrencesHash"
FROM "_legacy_occurrence_set_map" m;

CREATE TEMP TABLE "_legacy_occurrence_set_representative_post" AS
SELECT DISTINCT ON (m."imageOccurrenceSetId")
  m."imageOccurrenceSetId",
  m."postId"
FROM "_legacy_post_image_occurrence_set_map" m
ORDER BY m."imageOccurrenceSetId", m."postId";

INSERT INTO "ImageOccurrence" (
  "id",
  "occurrenceSetId",
  "originalIndex",
  "normalizedTextOffset",
  "sourceUrl",
  "captionText"
)
SELECT
  ('legacy_io_' || ROW_NUMBER() OVER (
    ORDER BY rep."imageOccurrenceSetId", pio."originalIndex", pio."id"
  )) AS "id",
  rep."imageOccurrenceSetId",
  pio."originalIndex",
  pio."normalizedTextOffset",
  pio."sourceUrl",
  CASE
    WHEN pio."captionText" IS NULL OR LENGTH(BTRIM(pio."captionText")) = 0
      THEN NULL
    ELSE BTRIM(pio."captionText")
  END AS "captionText"
FROM "_legacy_occurrence_set_representative_post" rep
JOIN "PostImageOccurrence" pio
  ON pio."postId" = rep."postId";

CREATE TEMP TABLE "_legacy_content_blob_map" AS
SELECT
  g."contentHash",
  MIN(g."contentText") AS "contentText",
  ('legacy_cb_' || ROW_NUMBER() OVER (ORDER BY g."contentHash")) AS "contentBlobId"
FROM "_legacy_version_source" g
GROUP BY g."contentHash";

INSERT INTO "ContentBlob" (
  "id",
  "contentHash",
  "contentText",
  "wordCount"
)
SELECT
  m."contentBlobId",
  m."contentHash",
  m."contentText",
  CASE
    WHEN LENGTH(BTRIM(m."contentText")) = 0 THEN 0
    ELSE COALESCE(ARRAY_LENGTH(REGEXP_SPLIT_TO_ARRAY(BTRIM(m."contentText"), E'\\s+'), 1), 0)
  END AS "wordCount"
FROM "_legacy_content_blob_map" m;

CREATE TEMP TABLE "_legacy_post_version_map" AS
SELECT
  s."postId",
  s."contentHash",
  ENCODE(DIGEST(s."contentHash" || E'\n' || ios."occurrencesHash", 'sha256'), 'hex') AS "versionHash",
  ('legacy_pv_' || ROW_NUMBER() OVER (ORDER BY s."postId", s."contentHash", ios."occurrencesHash")) AS "postVersionId",
  cb."contentBlobId",
  ios."imageOccurrenceSetId",
  ios."occurrencesHash",
  s."contentProvenance",
  s."fetchFailureReason",
  s."serverVerifiedAt",
  s."firstSeenAt",
  s."lastSeenAt",
  s."seenCount"
FROM "_legacy_version_source" s
JOIN "_legacy_content_blob_map" cb
  ON cb."contentHash" = s."contentHash"
JOIN "_legacy_post_image_occurrence_set_map" ios
  ON ios."postId" = s."postId";

INSERT INTO "PostVersion" (
  "id",
  "postId",
  "versionHash",
  "contentBlobId",
  "imageOccurrenceSetId",
  "contentProvenance",
  "fetchFailureReason",
  "serverVerifiedAt",
  "firstSeenAt",
  "lastSeenAt",
  "seenCount"
)
SELECT
  m."postVersionId",
  m."postId",
  m."versionHash",
  m."contentBlobId",
  m."imageOccurrenceSetId",
  m."contentProvenance",
  m."fetchFailureReason",
  m."serverVerifiedAt",
  m."firstSeenAt",
  m."lastSeenAt",
  m."seenCount"
FROM "_legacy_post_version_map" m;

-- Rewire Investigation onto PostVersion.
ALTER TABLE "Investigation"
  ADD COLUMN "postVersionId" TEXT;

UPDATE "Investigation" i
SET "postVersionId" = m."postVersionId"
FROM "_legacy_post_version_map" m
WHERE m."postId" = i."postId"
  AND m."contentHash" = i."contentHash";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Investigation" i
    WHERE i."postVersionId" IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot migrate legacy data: failed to assign postVersionId to every Investigation row';
  END IF;
END;
$$;

-- Remove old lineage triggers/functions that depend on dropped columns.
DROP TRIGGER IF EXISTS "enforce_investigation_parent_semantics_trigger"
  ON "Investigation";
DROP TRIGGER IF EXISTS "enforce_referenced_parent_investigation_validity_trigger"
  ON "Investigation";
DROP FUNCTION IF EXISTS "enforce_investigation_parent_semantics"();
DROP FUNCTION IF EXISTS "enforce_referenced_parent_investigation_validity"();

-- Drop constraints/indexes tied to legacy Investigation shape.
ALTER TABLE "Investigation"
  DROP CONSTRAINT IF EXISTS "Investigation_content_provenance_consistency_check",
  DROP CONSTRAINT IF EXISTS "Investigation_client_fallback_reason_check",
  DROP CONSTRAINT IF EXISTS "Investigation_client_fallback_reason_non_empty_check",
  DROP CONSTRAINT IF EXISTS "Investigation_isUpdate_parent_consistency_chk",
  DROP CONSTRAINT IF EXISTS "Investigation_parent_not_self_chk",
  DROP CONSTRAINT IF EXISTS "Investigation_contentDiff_parent_consistency_chk",
  DROP CONSTRAINT IF EXISTS "Investigation_parentInvestigationId_postId_fkey",
  DROP CONSTRAINT IF EXISTS "Investigation_id_postId_key",
  DROP CONSTRAINT IF EXISTS "Investigation_postId_fkey";

DROP INDEX IF EXISTS "Investigation_postId_status_idx";
DROP INDEX IF EXISTS "Investigation_postId_contentHash_key";
DROP INDEX IF EXISTS "Investigation_parentInvestigationId_idx";
DROP INDEX IF EXISTS "Investigation_isUpdate_idx";

ALTER TABLE "Investigation"
  DROP COLUMN "postId",
  DROP COLUMN "contentHash",
  DROP COLUMN "contentText",
  DROP COLUMN "contentProvenance",
  DROP COLUMN "fetchFailureReason",
  DROP COLUMN "serverVerifiedAt",
  DROP COLUMN "isUpdate";

ALTER TABLE "Investigation"
  ALTER COLUMN "postVersionId" SET NOT NULL;

CREATE INDEX "Investigation_status_idx"
  ON "Investigation"("status");

CREATE UNIQUE INDEX "Investigation_postVersionId_key"
  ON "Investigation"("postVersionId");

ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_postVersionId_fkey"
  FOREIGN KEY ("postVersionId") REFERENCES "PostVersion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_parentInvestigationId_fkey"
  FOREIGN KEY ("parentInvestigationId") REFERENCES "Investigation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Investigation_parentInvestigationId_idx"
  ON "Investigation"("parentInvestigationId");

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

CREATE TRIGGER "enforce_investigation_parent_semantics_trigger"
BEFORE INSERT OR UPDATE OF "parentInvestigationId", "postVersionId"
ON "Investigation"
FOR EACH ROW
EXECUTE FUNCTION "enforce_investigation_parent_semantics"();

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

CREATE TRIGGER "enforce_referenced_parent_investigation_validity_trigger"
BEFORE UPDATE OF "status", "checkedAt", "postVersionId"
ON "Investigation"
FOR EACH ROW
EXECUTE FUNCTION "enforce_referenced_parent_investigation_validity"();

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

CREATE TRIGGER "enforce_referenced_parent_post_version_validity_trigger"
BEFORE UPDATE OF "contentProvenance"
ON "PostVersion"
FOR EACH ROW
EXECUTE FUNCTION "enforce_referenced_parent_post_version_validity"();

-- Remove legacy denormalized Post columns and occurrence table.
ALTER TABLE "Post"
  DROP COLUMN IF EXISTS "latestContentHash",
  DROP COLUMN IF EXISTS "latestContentText",
  DROP COLUMN IF EXISTS "latestServerVerifiedContentHash",
  DROP COLUMN IF EXISTS "wordCount";

DROP TABLE IF EXISTS "PostImageOccurrence";
