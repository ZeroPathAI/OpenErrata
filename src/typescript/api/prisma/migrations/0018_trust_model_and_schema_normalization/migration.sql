-- Migration 0018: Trust model fix, markdown-only prompt, schema normalization.
--
-- 1. Drop post-level meta tables (redundant with version meta).
-- 2. Add HtmlBlob (content-addressed HTML storage).
-- 3. Add InvestigationInput (immutable investigation input snapshots).
-- 4. PostVersion: drop contentProvenance + fetchFailureReason, add serverVerifiedAt latch.
-- 5. Version meta: htmlContent → source-scoped HtmlBlob FKs (server/client).
-- 6. Drop/rewrite constraints and triggers that reference contentProvenance.

-- We rely on pgcrypto for SHA-256 hashing during HtmlBlob backfill.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- Phase 1: Create new tables
-- ============================================================================

CREATE TABLE "HtmlBlob" (
  "id" TEXT NOT NULL,
  "htmlHash" TEXT NOT NULL,
  "htmlContent" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "HtmlBlob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HtmlBlob_htmlHash_key" ON "HtmlBlob"("htmlHash");

CREATE TABLE "InvestigationInput" (
  "investigationId" TEXT NOT NULL,
  "provenance" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "markdownSource" TEXT NOT NULL,
  "markdown" TEXT,
  "markdownRendererVersion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InvestigationInput_pkey" PRIMARY KEY ("investigationId")
);

ALTER TABLE "InvestigationInput"
  ADD CONSTRAINT "InvestigationInput_provenance_chk"
  CHECK ("provenance" IN ('SERVER_VERIFIED', 'CLIENT_FALLBACK'));

ALTER TABLE "InvestigationInput"
  ADD CONSTRAINT "InvestigationInput_markdownSource_chk"
  CHECK ("markdownSource" IN ('SERVER_HTML', 'CLIENT_HTML', 'NONE'));

ALTER TABLE "InvestigationInput"
  ADD CONSTRAINT "InvestigationInput_markdown_source_consistency_chk"
  CHECK (("markdownSource" = 'NONE') = ("markdown" IS NULL));

ALTER TABLE "InvestigationInput"
  ADD CONSTRAINT "InvestigationInput_renderer_source_consistency_chk"
  CHECK (("markdownSource" = 'NONE') = ("markdownRendererVersion" IS NULL));

-- Backfill InvestigationInput for pre-existing investigations.
-- Provenance is derived from PostVersion.serverVerifiedAt (before the column is dropped).
-- markdownSource = NONE for all backfilled rows (markdown was not generated at
-- the time these investigations ran under the old two-representation model).
INSERT INTO "InvestigationInput" (
  "investigationId",
  "provenance",
  "contentHash",
  "markdownSource"
)
SELECT
  i."id" AS "investigationId",
  CASE WHEN pv."serverVerifiedAt" IS NOT NULL
    THEN 'SERVER_VERIFIED'
    ELSE 'CLIENT_FALLBACK'
  END AS "provenance",
  cb."contentHash",
  'NONE' AS "markdownSource"
FROM "Investigation" i
JOIN "PostVersion" pv ON pv."id" = i."postVersionId"
JOIN "ContentBlob" cb ON cb."id" = pv."contentBlobId"
WHERE NOT EXISTS (
  SELECT 1 FROM "InvestigationInput" ii WHERE ii."investigationId" = i."id"
);

-- Investigation owns the 1:1 snapshot relation via inputId.
-- Keep inputId equal to Investigation.id so legacy joins by investigation id stay
-- valid while enforcing non-null snapshot linkage at the Investigation row.
ALTER TABLE "Investigation"
  ADD COLUMN "inputId" TEXT;

UPDATE "Investigation"
SET "inputId" = "id"
WHERE "inputId" IS NULL;

ALTER TABLE "Investigation"
  ALTER COLUMN "inputId" SET NOT NULL;

CREATE UNIQUE INDEX "Investigation_inputId_key" ON "Investigation"("inputId");

ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_inputId_matches_id_chk"
  CHECK ("inputId" = "id");

ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_inputId_fkey"
  FOREIGN KEY ("inputId") REFERENCES "InvestigationInput"("investigationId")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- ============================================================================
-- Phase 2: Create version meta tables (with source-scoped html blob FKs)
-- ============================================================================

CREATE TABLE "LesswrongVersionMeta" (
  "postVersionId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT,
  "serverHtmlBlobId" TEXT,
  "clientHtmlBlobId" TEXT,
  "imageUrls" TEXT[] NOT NULL,
  "karma" INTEGER,
  "authorName" TEXT,
  "authorSlug" TEXT,
  "tags" TEXT[] NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LesswrongVersionMeta_pkey" PRIMARY KEY ("postVersionId")
);

CREATE TABLE "XVersionMeta" (
  "postVersionId" TEXT NOT NULL,
  "tweetId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "authorHandle" TEXT NOT NULL,
  "authorDisplayName" TEXT,
  "mediaUrls" TEXT[] NOT NULL,
  "likeCount" INTEGER,
  "retweetCount" INTEGER,
  "postedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "XVersionMeta_pkey" PRIMARY KEY ("postVersionId")
);

CREATE TABLE "SubstackVersionMeta" (
  "postVersionId" TEXT NOT NULL,
  "substackPostId" TEXT NOT NULL,
  "publicationSubdomain" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "subtitle" TEXT,
  "serverHtmlBlobId" TEXT,
  "clientHtmlBlobId" TEXT,
  "imageUrls" TEXT[] NOT NULL,
  "authorName" TEXT NOT NULL,
  "authorSubstackHandle" TEXT,
  "publishedAt" TIMESTAMP(3),
  "likeCount" INTEGER,
  "commentCount" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SubstackVersionMeta_pkey" PRIMARY KEY ("postVersionId")
);

CREATE TABLE "WikipediaVersionMeta" (
  "postVersionId" TEXT NOT NULL,
  "pageId" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "displayTitle" TEXT,
  "serverHtmlBlobId" TEXT,
  "clientHtmlBlobId" TEXT,
  "revisionId" TEXT NOT NULL,
  "lastModifiedAt" TIMESTAMP(3),
  "imageUrls" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WikipediaVersionMeta_pkey" PRIMARY KEY ("postVersionId")
);

CREATE INDEX "LesswrongVersionMeta_slug_idx"
  ON "LesswrongVersionMeta"("slug");
CREATE INDEX "XVersionMeta_tweetId_idx"
  ON "XVersionMeta"("tweetId");
CREATE INDEX "SubstackVersionMeta_publicationSubdomain_slug_idx"
  ON "SubstackVersionMeta"("publicationSubdomain", "slug");
CREATE INDEX "SubstackVersionMeta_substackPostId_idx"
  ON "SubstackVersionMeta"("substackPostId");
CREATE INDEX "WikipediaVersionMeta_language_pageId_idx"
  ON "WikipediaVersionMeta"("language", "pageId");
CREATE INDEX "WikipediaVersionMeta_revisionId_idx"
  ON "WikipediaVersionMeta"("revisionId");

ALTER TABLE "LesswrongVersionMeta"
  ADD CONSTRAINT "LesswrongVersionMeta_postVersionId_fkey"
  FOREIGN KEY ("postVersionId") REFERENCES "PostVersion"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
ALTER TABLE "LesswrongVersionMeta"
  ADD CONSTRAINT "LesswrongVersionMeta_serverHtmlBlobId_fkey"
  FOREIGN KEY ("serverHtmlBlobId") REFERENCES "HtmlBlob"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
ALTER TABLE "LesswrongVersionMeta"
  ADD CONSTRAINT "LesswrongVersionMeta_clientHtmlBlobId_fkey"
  FOREIGN KEY ("clientHtmlBlobId") REFERENCES "HtmlBlob"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
ALTER TABLE "LesswrongVersionMeta"
  ADD CONSTRAINT "LesswrongVersionMeta_html_source_present_chk"
  CHECK ("serverHtmlBlobId" IS NOT NULL OR "clientHtmlBlobId" IS NOT NULL);

ALTER TABLE "XVersionMeta"
  ADD CONSTRAINT "XVersionMeta_postVersionId_fkey"
  FOREIGN KEY ("postVersionId") REFERENCES "PostVersion"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "SubstackVersionMeta"
  ADD CONSTRAINT "SubstackVersionMeta_postVersionId_fkey"
  FOREIGN KEY ("postVersionId") REFERENCES "PostVersion"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
ALTER TABLE "SubstackVersionMeta"
  ADD CONSTRAINT "SubstackVersionMeta_serverHtmlBlobId_fkey"
  FOREIGN KEY ("serverHtmlBlobId") REFERENCES "HtmlBlob"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
ALTER TABLE "SubstackVersionMeta"
  ADD CONSTRAINT "SubstackVersionMeta_clientHtmlBlobId_fkey"
  FOREIGN KEY ("clientHtmlBlobId") REFERENCES "HtmlBlob"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "WikipediaVersionMeta"
  ADD CONSTRAINT "WikipediaVersionMeta_postVersionId_fkey"
  FOREIGN KEY ("postVersionId") REFERENCES "PostVersion"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
ALTER TABLE "WikipediaVersionMeta"
  ADD CONSTRAINT "WikipediaVersionMeta_serverHtmlBlobId_fkey"
  FOREIGN KEY ("serverHtmlBlobId") REFERENCES "HtmlBlob"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
ALTER TABLE "WikipediaVersionMeta"
  ADD CONSTRAINT "WikipediaVersionMeta_clientHtmlBlobId_fkey"
  FOREIGN KEY ("clientHtmlBlobId") REFERENCES "HtmlBlob"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- ============================================================================
-- Phase 2b: Backfill version metadata from legacy post-level meta tables
-- ============================================================================

-- LessWrong legacy rows carry HTML. Backfill HtmlBlob first so version meta can
-- reference content-addressed blobs by hash.
INSERT INTO "HtmlBlob" ("id", "htmlHash", "htmlContent")
SELECT
  'legacy_html_' || encode(digest(lm."htmlContent", 'sha256'), 'hex') AS "id",
  encode(digest(lm."htmlContent", 'sha256'), 'hex') AS "htmlHash",
  lm."htmlContent"
FROM "LesswrongMeta" lm
ON CONFLICT DO NOTHING;

INSERT INTO "LesswrongVersionMeta" (
  "postVersionId",
  "slug",
  "title",
  "serverHtmlBlobId",
  "clientHtmlBlobId",
  "imageUrls",
  "karma",
  "authorName",
  "authorSlug",
  "tags",
  "publishedAt",
  "createdAt"
)
SELECT
  pv."id" AS "postVersionId",
  lm."slug",
  NULLIF(BTRIM(lm."title"), '') AS "title",
  hb."id" AS "serverHtmlBlobId",
  hb."id" AS "clientHtmlBlobId",
  lm."imageUrls",
  lm."karma",
  NULLIF(BTRIM(lm."authorName"), '') AS "authorName",
  NULLIF(BTRIM(lm."authorSlug"), '') AS "authorSlug",
  lm."tags",
  lm."publishedAt",
  pv."firstSeenAt" AS "createdAt"
FROM "PostVersion" pv
JOIN "Post" p
  ON p."id" = pv."postId"
 AND p."platform" = 'LESSWRONG'
JOIN "LesswrongMeta" lm
  ON lm."postId" = p."id"
JOIN "HtmlBlob" hb
  ON hb."htmlHash" = encode(digest(lm."htmlContent", 'sha256'), 'hex')
ON CONFLICT ("postVersionId") DO NOTHING;

INSERT INTO "XVersionMeta" (
  "postVersionId",
  "tweetId",
  "text",
  "authorHandle",
  "authorDisplayName",
  "mediaUrls",
  "likeCount",
  "retweetCount",
  "postedAt",
  "createdAt"
)
SELECT
  pv."id" AS "postVersionId",
  xm."tweetId",
  xm."text",
  xm."authorHandle",
  xm."authorDisplayName",
  xm."mediaUrls",
  xm."likeCount",
  xm."retweetCount",
  xm."postedAt",
  pv."firstSeenAt" AS "createdAt"
FROM "PostVersion" pv
JOIN "Post" p
  ON p."id" = pv."postId"
 AND p."platform" = 'X'
JOIN "XMeta" xm
  ON xm."postId" = p."id"
ON CONFLICT ("postVersionId") DO NOTHING;

INSERT INTO "SubstackVersionMeta" (
  "postVersionId",
  "substackPostId",
  "publicationSubdomain",
  "slug",
  "title",
  "subtitle",
  "serverHtmlBlobId",
  "clientHtmlBlobId",
  "imageUrls",
  "authorName",
  "authorSubstackHandle",
  "publishedAt",
  "likeCount",
  "commentCount",
  "createdAt"
)
SELECT
  pv."id" AS "postVersionId",
  sm."substackPostId",
  sm."publicationSubdomain",
  sm."slug",
  sm."title",
  sm."subtitle",
  NULL::TEXT AS "serverHtmlBlobId",
  NULL::TEXT AS "clientHtmlBlobId",
  sm."imageUrls",
  sm."authorName",
  sm."authorSubstackHandle",
  sm."publishedAt",
  sm."likeCount",
  sm."commentCount",
  pv."firstSeenAt" AS "createdAt"
FROM "PostVersion" pv
JOIN "Post" p
  ON p."id" = pv."postId"
 AND p."platform" = 'SUBSTACK'
JOIN "SubstackMeta" sm
  ON sm."postId" = p."id"
ON CONFLICT ("postVersionId") DO NOTHING;

INSERT INTO "WikipediaVersionMeta" (
  "postVersionId",
  "pageId",
  "language",
  "title",
  "displayTitle",
  "serverHtmlBlobId",
  "clientHtmlBlobId",
  "revisionId",
  "lastModifiedAt",
  "imageUrls",
  "createdAt"
)
SELECT
  pv."id" AS "postVersionId",
  wm."pageId",
  wm."language",
  wm."title",
  wm."displayTitle",
  NULL::TEXT AS "serverHtmlBlobId",
  NULL::TEXT AS "clientHtmlBlobId",
  wm."revisionId",
  wm."lastModifiedAt",
  wm."imageUrls",
  pv."firstSeenAt" AS "createdAt"
FROM "PostVersion" pv
JOIN "Post" p
  ON p."id" = pv."postId"
 AND p."platform" = 'WIKIPEDIA'
JOIN "WikipediaMeta" wm
  ON wm."postId" = p."id"
ON CONFLICT ("postVersionId") DO NOTHING;

-- ============================================================================
-- Phase 3: Drop post-level meta tables + triggers
-- ============================================================================

-- Drop triggers first (before dropping tables/functions)
DROP TRIGGER IF EXISTS "reject_lesswrong_meta_updates_trigger" ON "LesswrongMeta";
DROP TRIGGER IF EXISTS "reject_x_meta_updates_trigger" ON "XMeta";
DROP TRIGGER IF EXISTS "reject_substack_meta_updates_trigger" ON "SubstackMeta";
DROP TRIGGER IF EXISTS "reject_wikipedia_meta_updates_trigger" ON "WikipediaMeta";

-- Drop trigger functions
DROP FUNCTION IF EXISTS "reject_lesswrong_meta_updates"();
DROP FUNCTION IF EXISTS "reject_x_meta_updates"();
DROP FUNCTION IF EXISTS "reject_substack_meta_updates"();
DROP FUNCTION IF EXISTS "reject_wikipedia_meta_updates"();

-- Drop post-level meta tables (CASCADE drops FKs, indexes, constraints)
DROP TABLE IF EXISTS "LesswrongMeta" CASCADE;
DROP TABLE IF EXISTS "XMeta" CASCADE;
DROP TABLE IF EXISTS "SubstackMeta" CASCADE;
DROP TABLE IF EXISTS "WikipediaMeta" CASCADE;

-- ============================================================================
-- Phase 4: Modify PostVersion — drop contentProvenance + fetchFailureReason
-- ============================================================================

-- Drop constraints that reference contentProvenance (from 0016/0017).
-- Some may have been auto-dropped by 0017; use IF EXISTS for safety.
ALTER TABLE "PostVersion"
  DROP CONSTRAINT IF EXISTS "PostVersion_server_verified_reason_chk",
  DROP CONSTRAINT IF EXISTS "PostVersion_server_verified_at_chk",
  DROP CONSTRAINT IF EXISTS "PostVersion_content_provenance_consistency_check";

-- Drop trigger that fires on UPDATE OF contentProvenance (from 0017).
-- PostgreSQL would auto-drop it when the column is dropped, but explicit is clearer.
DROP TRIGGER IF EXISTS "enforce_referenced_parent_post_version_validity_trigger"
  ON "PostVersion";
DROP FUNCTION IF EXISTS "enforce_referenced_parent_post_version_validity"();

-- Drop the index that includes contentProvenance.
DROP INDEX IF EXISTS "PostVersion_postId_contentProvenance_lastSeenAt_idx";

-- Drop columns.
ALTER TABLE "PostVersion" DROP COLUMN IF EXISTS "contentProvenance";
ALTER TABLE "PostVersion" DROP COLUMN IF EXISTS "fetchFailureReason";

-- 0015 creates session-scoped TEMP tables that still reference the enum when
-- migrations are applied from scratch in one Prisma session. Remove them
-- defensively before dropping the enum type.
DROP TABLE IF EXISTS "_legacy_version_source";
DROP TABLE IF EXISTS "_legacy_post_version_map";

-- Drop the ContentProvenance enum type. CASCADE covers any remaining
-- dependencies (e.g. temp table columns that survived from migration 0015
-- when Prisma reuses the same session across migrations).
DROP TYPE IF EXISTS "ContentProvenance" CASCADE;

-- ============================================================================
-- Phase 5: serverVerifiedAt one-way latch trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION "enforce_server_verified_at_latch"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."serverVerifiedAt" IS NOT NULL
     AND NEW."serverVerifiedAt" IS DISTINCT FROM OLD."serverVerifiedAt"
  THEN
    RAISE EXCEPTION
      'serverVerifiedAt is a one-way latch; once set it cannot be changed (postVersionId=%)',
      NEW."id";
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "enforce_server_verified_at_latch_trigger"
  ON "PostVersion";
CREATE TRIGGER "enforce_server_verified_at_latch_trigger"
BEFORE UPDATE OF "serverVerifiedAt"
ON "PostVersion"
FOR EACH ROW
EXECUTE FUNCTION "enforce_server_verified_at_latch"();

-- Ensure server-verified PostVersions cannot commit without a server-side HTML
-- snapshot on platforms that use HTML (LESSWRONG, SUBSTACK, WIKIPEDIA).
-- Deferred so PostVersion + *VersionMeta creation can occur in one transaction.
CREATE OR REPLACE FUNCTION "enforce_server_verified_html_snapshot"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  post_platform "Platform";
  has_server_html BOOLEAN;
BEGIN
  IF NEW."serverVerifiedAt" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p."platform"
  INTO post_platform
  FROM "Post" p
  WHERE p."id" = NEW."postId";

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'PostVersion references missing Post (postVersionId=%, postId=%)',
      NEW."id",
      NEW."postId";
  END IF;

  IF post_platform = 'X' THEN
    RETURN NEW;
  END IF;

  IF post_platform = 'LESSWRONG' THEN
    SELECT (lwm."serverHtmlBlobId" IS NOT NULL)
    INTO has_server_html
    FROM "LesswrongVersionMeta" lwm
    WHERE lwm."postVersionId" = NEW."id";
  ELSIF post_platform = 'SUBSTACK' THEN
    SELECT (svm."serverHtmlBlobId" IS NOT NULL)
    INTO has_server_html
    FROM "SubstackVersionMeta" svm
    WHERE svm."postVersionId" = NEW."id";
  ELSIF post_platform = 'WIKIPEDIA' THEN
    SELECT (wvm."serverHtmlBlobId" IS NOT NULL)
    INTO has_server_html
    FROM "WikipediaVersionMeta" wvm
    WHERE wvm."postVersionId" = NEW."id";
  ELSE
    RAISE EXCEPTION
      'Unsupported platform on PostVersion (postVersionId=%, platform=%)',
      NEW."id",
      post_platform;
  END IF;

  IF has_server_html IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'serverVerifiedAt requires a server HTML snapshot (postVersionId=%, platform=%)',
      NEW."id",
      post_platform;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "enforce_server_verified_html_snapshot_trigger"
  ON "PostVersion";
CREATE CONSTRAINT TRIGGER "enforce_server_verified_html_snapshot_trigger"
AFTER INSERT OR UPDATE OF "serverVerifiedAt"
ON "PostVersion"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_server_verified_html_snapshot"();

-- ============================================================================
-- Phase 6: Rewrite update-lineage triggers (read from InvestigationInput)
-- ============================================================================

-- Rewrite: enforce_investigation_parent_semantics
-- Previously read contentProvenance from PostVersion; now reads from InvestigationInput.
CREATE OR REPLACE FUNCTION "enforce_investigation_parent_semantics"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status "CheckStatus";
  parent_checked_at TIMESTAMP(3);
  parent_post_id TEXT;
  parent_provenance TEXT;
  child_post_id TEXT;
BEGIN
  IF NEW."parentInvestigationId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT
    parent_i."status",
    parent_i."checkedAt",
    parent_pv."postId",
    parent_input."provenance"
  INTO
    parent_status,
    parent_checked_at,
    parent_post_id,
    parent_provenance
  FROM "Investigation" parent_i
  JOIN "PostVersion" parent_pv
    ON parent_pv."id" = parent_i."postVersionId"
  LEFT JOIN "InvestigationInput" parent_input
    ON parent_input."investigationId" = parent_i."id"
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

  IF parent_provenance IS NULL THEN
    RAISE EXCEPTION
      'Update parent investigation must have InvestigationInput (parentInvestigationId=%)',
      NEW."parentInvestigationId";
  END IF;

  IF parent_provenance <> 'SERVER_VERIFIED' THEN
    RAISE EXCEPTION
      'Update parent investigation must be SERVER_VERIFIED (parentInvestigationId=%, provenance=%)',
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

-- Rewrite: enforce_referenced_parent_investigation_validity
-- Previously read contentProvenance from PostVersion; now reads from InvestigationInput.
CREATE OR REPLACE FUNCTION "enforce_referenced_parent_investigation_validity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_post_id TEXT;
  parent_provenance TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "Investigation" child
    WHERE child."parentInvestigationId" = NEW."id"
    LIMIT 1
  ) THEN
    RETURN NEW;
  END IF;

  SELECT pv."postId"
  INTO parent_post_id
  FROM "PostVersion" pv
  WHERE pv."id" = NEW."postVersionId";

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Referenced parent investigation must have a valid postVersion (id=%)',
      NEW."id";
  END IF;

  SELECT input."provenance"
  INTO parent_provenance
  FROM "InvestigationInput" input
  WHERE input."investigationId" = NEW."id";

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

  IF parent_provenance IS NULL THEN
    RAISE EXCEPTION
      'Referenced parent investigation must have InvestigationInput (id=%)',
      NEW."id";
  END IF;

  IF parent_provenance <> 'SERVER_VERIFIED' THEN
    RAISE EXCEPTION
      'Referenced parent investigation must stay SERVER_VERIFIED (id=%, provenance=%)',
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

-- Recreate the triggers (functions were replaced above via CREATE OR REPLACE).
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

-- ============================================================================
-- Phase 7: InvestigationInput immutability trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION "reject_investigation_input_updates"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'InvestigationInput is immutable; updates are not allowed (investigationId=%)',
    NEW."investigationId";
END;
$$;

DROP TRIGGER IF EXISTS "reject_investigation_input_updates_trigger"
  ON "InvestigationInput";
CREATE TRIGGER "reject_investigation_input_updates_trigger"
BEFORE UPDATE
ON "InvestigationInput"
FOR EACH ROW
EXECUTE FUNCTION "reject_investigation_input_updates"();

-- ============================================================================
-- Phase 8: Version meta immutability triggers
-- ============================================================================

CREATE OR REPLACE FUNCTION "reject_lesswrong_version_meta_updates"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    (
      (OLD."serverHtmlBlobId" IS NULL AND NEW."serverHtmlBlobId" IS NOT NULL)
      OR NEW."serverHtmlBlobId" IS NOT DISTINCT FROM OLD."serverHtmlBlobId"
    )
    AND (
      (OLD."clientHtmlBlobId" IS NULL AND NEW."clientHtmlBlobId" IS NOT NULL)
      OR NEW."clientHtmlBlobId" IS NOT DISTINCT FROM OLD."clientHtmlBlobId"
    )
    AND NEW."postVersionId" IS NOT DISTINCT FROM OLD."postVersionId"
    AND NEW."slug" IS NOT DISTINCT FROM OLD."slug"
    AND NEW."title" IS NOT DISTINCT FROM OLD."title"
    AND NEW."imageUrls" IS NOT DISTINCT FROM OLD."imageUrls"
    AND NEW."karma" IS NOT DISTINCT FROM OLD."karma"
    AND NEW."authorName" IS NOT DISTINCT FROM OLD."authorName"
    AND NEW."authorSlug" IS NOT DISTINCT FROM OLD."authorSlug"
    AND NEW."tags" IS NOT DISTINCT FROM OLD."tags"
    AND NEW."publishedAt" IS NOT DISTINCT FROM OLD."publishedAt"
    AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'LesswrongVersionMeta is immutable; updates are not allowed except server/client HTML blob NULL->value enrichment (postVersionId=%)', NEW."postVersionId";
END;
$$;

CREATE OR REPLACE FUNCTION "reject_x_version_meta_updates"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'XVersionMeta is immutable; updates are not allowed (postVersionId=%)', NEW."postVersionId";
END;
$$;

CREATE OR REPLACE FUNCTION "reject_substack_version_meta_updates"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    (
      (OLD."serverHtmlBlobId" IS NULL AND NEW."serverHtmlBlobId" IS NOT NULL)
      OR NEW."serverHtmlBlobId" IS NOT DISTINCT FROM OLD."serverHtmlBlobId"
    )
    AND (
      (OLD."clientHtmlBlobId" IS NULL AND NEW."clientHtmlBlobId" IS NOT NULL)
      OR NEW."clientHtmlBlobId" IS NOT DISTINCT FROM OLD."clientHtmlBlobId"
    )
    AND NEW."postVersionId" IS NOT DISTINCT FROM OLD."postVersionId"
    AND NEW."substackPostId" IS NOT DISTINCT FROM OLD."substackPostId"
    AND NEW."publicationSubdomain" IS NOT DISTINCT FROM OLD."publicationSubdomain"
    AND NEW."slug" IS NOT DISTINCT FROM OLD."slug"
    AND NEW."title" IS NOT DISTINCT FROM OLD."title"
    AND NEW."subtitle" IS NOT DISTINCT FROM OLD."subtitle"
    AND NEW."imageUrls" IS NOT DISTINCT FROM OLD."imageUrls"
    AND NEW."authorName" IS NOT DISTINCT FROM OLD."authorName"
    AND NEW."authorSubstackHandle" IS NOT DISTINCT FROM OLD."authorSubstackHandle"
    AND NEW."publishedAt" IS NOT DISTINCT FROM OLD."publishedAt"
    AND NEW."likeCount" IS NOT DISTINCT FROM OLD."likeCount"
    AND NEW."commentCount" IS NOT DISTINCT FROM OLD."commentCount"
    AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SubstackVersionMeta is immutable; updates are not allowed except server/client HTML blob NULL->value enrichment (postVersionId=%)', NEW."postVersionId";
END;
$$;

CREATE OR REPLACE FUNCTION "reject_wikipedia_version_meta_updates"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    (
      (OLD."serverHtmlBlobId" IS NULL AND NEW."serverHtmlBlobId" IS NOT NULL)
      OR NEW."serverHtmlBlobId" IS NOT DISTINCT FROM OLD."serverHtmlBlobId"
    )
    AND (
      (OLD."clientHtmlBlobId" IS NULL AND NEW."clientHtmlBlobId" IS NOT NULL)
      OR NEW."clientHtmlBlobId" IS NOT DISTINCT FROM OLD."clientHtmlBlobId"
    )
    AND NEW."postVersionId" IS NOT DISTINCT FROM OLD."postVersionId"
    AND NEW."pageId" IS NOT DISTINCT FROM OLD."pageId"
    AND NEW."language" IS NOT DISTINCT FROM OLD."language"
    AND NEW."title" IS NOT DISTINCT FROM OLD."title"
    AND NEW."displayTitle" IS NOT DISTINCT FROM OLD."displayTitle"
    AND NEW."revisionId" IS NOT DISTINCT FROM OLD."revisionId"
    AND NEW."lastModifiedAt" IS NOT DISTINCT FROM OLD."lastModifiedAt"
    AND NEW."imageUrls" IS NOT DISTINCT FROM OLD."imageUrls"
    AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'WikipediaVersionMeta is immutable; updates are not allowed except server/client HTML blob NULL->value enrichment (postVersionId=%)', NEW."postVersionId";
END;
$$;

DROP TRIGGER IF EXISTS "reject_lesswrong_version_meta_updates_trigger"
  ON "LesswrongVersionMeta";
CREATE TRIGGER "reject_lesswrong_version_meta_updates_trigger"
BEFORE UPDATE
ON "LesswrongVersionMeta"
FOR EACH ROW
EXECUTE FUNCTION "reject_lesswrong_version_meta_updates"();

DROP TRIGGER IF EXISTS "reject_x_version_meta_updates_trigger"
  ON "XVersionMeta";
CREATE TRIGGER "reject_x_version_meta_updates_trigger"
BEFORE UPDATE
ON "XVersionMeta"
FOR EACH ROW
EXECUTE FUNCTION "reject_x_version_meta_updates"();

DROP TRIGGER IF EXISTS "reject_substack_version_meta_updates_trigger"
  ON "SubstackVersionMeta";
CREATE TRIGGER "reject_substack_version_meta_updates_trigger"
BEFORE UPDATE
ON "SubstackVersionMeta"
FOR EACH ROW
EXECUTE FUNCTION "reject_substack_version_meta_updates"();

DROP TRIGGER IF EXISTS "reject_wikipedia_version_meta_updates_trigger"
  ON "WikipediaVersionMeta";
CREATE TRIGGER "reject_wikipedia_version_meta_updates_trigger"
BEFORE UPDATE
ON "WikipediaVersionMeta"
FOR EACH ROW
EXECUTE FUNCTION "reject_wikipedia_version_meta_updates"();
