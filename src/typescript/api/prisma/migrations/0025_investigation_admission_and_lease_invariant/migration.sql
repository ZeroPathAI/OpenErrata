-- ============================================================================
-- Migration 0025: investigation admission, lease invariant, input snapshot
-- ============================================================================
--
-- 1. Investigation.origin + admittedAt record who admitted (and therefore pays
--    for) each investigation, so the selector budget can count its own
--    admissions per UTC day.
-- 2. "InvestigationLease row exists iff status = PROCESSING" moves from code
--    comments into deferred constraint triggers checked at commit.
-- 3. Post.identityVerifiedAt latches once url/author come from a server fetch;
--    stored non-HTTPS post URLs are rebuilt from platform identity.
-- 4. InvestigationInput snapshots the prompt context (post URL, author,
--    publication time, video flag) and the source URL behind every [IMAGE:N]
--    markdown placeholder at queue time.
-- 5. Source.snapshotText/snapshotHash/retrievedAt are dropped: they only ever
--    held a copy of the snippet and the save time.
-- 6. SubstackVersionMeta.serverHtmlBlobId is dropped: Substack has no
--    server-side fetch, so it could never be populated.
-- 7. The LessWrong/Substack/Wikipedia version-meta triggers are renamed: they
--    enforce an update policy, they no longer reject updates.

-- ── 1. Investigation origin / admission ─────────────────────────────────────

CREATE TYPE "InvestigationOrigin" AS ENUM ('SELECTOR', 'INSTANCE_REQUEST', 'USER_KEY_REQUEST');

ALTER TABLE "Investigation"
  ADD COLUMN "origin" "InvestigationOrigin",
  ADD COLUMN "admittedAt" TIMESTAMP(3);

-- Historical rows: an attached user-key source identifies a user-key request.
-- Selector and instance-key requests cannot be told apart after the fact, so
-- they are recorded as SELECTOR. That is the conservative choice for the daily
-- budget: rows created earlier today count against today's selector budget.
UPDATE "Investigation" i
SET
  "origin" = CASE
    WHEN EXISTS (
      SELECT 1 FROM "InvestigationOpenAiKeySource" ks WHERE ks."investigationId" = i."id"
    ) THEN 'USER_KEY_REQUEST'::"InvestigationOrigin"
    ELSE 'SELECTOR'::"InvestigationOrigin"
  END,
  "admittedAt" = i."createdAt";

ALTER TABLE "Investigation"
  ALTER COLUMN "origin" SET NOT NULL,
  ALTER COLUMN "admittedAt" SET NOT NULL;

CREATE INDEX "Investigation_origin_admittedAt_idx" ON "Investigation"("origin", "admittedAt");

-- ── 2. Lease row exists iff status = PROCESSING ─────────────────────────────

-- Repair rows that violate the invariant before enforcing it.
DELETE FROM "InvestigationLease" l
USING "Investigation" i
WHERE i."id" = l."investigationId"
  AND i."status" <> 'PROCESSING';

UPDATE "Investigation" i
SET "status" = 'PENDING', "queuedAt" = CURRENT_TIMESTAMP
WHERE i."status" = 'PROCESSING'
  AND NOT EXISTS (
    SELECT 1 FROM "InvestigationLease" l WHERE l."investigationId" = i."id"
  );

CREATE FUNCTION "assert_investigation_lease_matches_status"(target_investigation_id TEXT)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  current_status "CheckStatus";
  has_lease BOOLEAN;
BEGIN
  SELECT i."status"
  INTO current_status
  FROM "Investigation" i
  WHERE i."id" = target_investigation_id;

  IF NOT FOUND THEN
    -- The investigation was deleted; its lease row cascades with it.
    RETURN;
  END IF;

  has_lease := EXISTS (
    SELECT 1 FROM "InvestigationLease" l WHERE l."investigationId" = target_investigation_id
  );

  IF (current_status = 'PROCESSING') IS DISTINCT FROM has_lease THEN
    RAISE EXCEPTION
      'Investigation % has status % but its lease row %; a lease row must exist iff status = PROCESSING',
      target_investigation_id,
      current_status,
      CASE WHEN has_lease THEN 'exists' ELSE 'is missing' END
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE FUNCTION "enforce_lease_status_on_investigation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "assert_investigation_lease_matches_status"(NEW."id");
  RETURN NULL;
END;
$$;

CREATE FUNCTION "enforce_lease_status_on_lease"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM "assert_investigation_lease_matches_status"(OLD."investigationId");
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM "assert_investigation_lease_matches_status"(NEW."investigationId");
  END IF;
  RETURN NULL;
END;
$$;

-- Deferred so status and lease changes made in one transaction are checked
-- together at commit.
CREATE CONSTRAINT TRIGGER "enforce_lease_status_on_investigation_trigger"
AFTER INSERT OR UPDATE OF "status"
ON "Investigation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_lease_status_on_investigation"();

CREATE CONSTRAINT TRIGGER "enforce_lease_status_on_lease_trigger"
AFTER INSERT OR UPDATE OR DELETE
ON "InvestigationLease"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_lease_status_on_lease"();

-- ── 3. Post identity ───────────────────────────────────────────────────────

ALTER TABLE "Post" ADD COLUMN "identityVerifiedAt" TIMESTAMP(3);

CREATE FUNCTION "enforce_post_identity_verified_at_latch"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."identityVerifiedAt" IS NOT NULL AND NEW."identityVerifiedAt" IS NULL THEN
    RAISE EXCEPTION
      'Post.identityVerifiedAt cannot be cleared once a server fetch verified the post identity (postId=%)',
      NEW."id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "enforce_post_identity_verified_at_latch_trigger"
BEFORE UPDATE OF "identityVerifiedAt"
ON "Post"
FOR EACH ROW
EXECUTE FUNCTION "enforce_post_identity_verified_at_latch"();

-- Post.url used to be overwritten by whatever an unauthenticated client sent,
-- including non-HTTP(S) schemes. Rebuild any such URL from platform identity.
UPDATE "Post" p
SET "url" = CASE p."platform"
  WHEN 'LESSWRONG' THEN 'https://www.lesswrong.com/posts/' || p."externalId"
  WHEN 'X' THEN 'https://x.com/i/status/' || p."externalId"
  WHEN 'WIKIPEDIA' THEN
    'https://' || split_part(p."externalId", ':', 1) || '.wikipedia.org/?curid=' || split_part(p."externalId", ':', 2)
  WHEN 'SUBSTACK' THEN (
    SELECT 'https://' || svm."publicationSubdomain" || '.substack.com/p/' || svm."slug"
    FROM "SubstackVersionMeta" svm
    JOIN "PostVersion" pv ON pv."id" = svm."postVersionId"
    WHERE pv."postId" = p."id"
    ORDER BY pv."lastSeenAt" DESC, pv."id" DESC
    LIMIT 1
  )
END
WHERE p."url" !~* '^https://';

-- ── 4. InvestigationInput prompt-context snapshot ───────────────────────────

-- Inputs whose investigation was deleted have nothing to snapshot and are
-- never read again.
DELETE FROM "InvestigationInput" ii
WHERE NOT EXISTS (
  SELECT 1 FROM "Investigation" i WHERE i."inputId" = ii."investigationId"
);

ALTER TABLE "InvestigationInput"
  ADD COLUMN "imagePlaceholderSourceUrls" TEXT[],
  ADD COLUMN "postUrl" TEXT,
  ADD COLUMN "authorName" TEXT,
  ADD COLUMN "postPublishedAt" TIMESTAMP(3),
  ADD COLUMN "hasVideo" BOOLEAN;

ALTER TABLE "InvestigationInput" DISABLE TRIGGER "reject_investigation_input_updates_trigger";

-- Backfill from the live rows the worker used to read at run time. Placeholder
-- source URLs cannot be recovered from stored markdown, so historical rows get
-- none (see the in-flight downgrade below).
UPDATE "InvestigationInput" ii
SET
  "postUrl" = p."url",
  "authorName" = a."displayName",
  "postPublishedAt" = COALESCE(
    lwm."publishedAt",
    xvm."postedAt",
    svm."publishedAt",
    wvm."lastModifiedAt"
  ),
  "hasVideo" = COALESCE(
    (
      SELECT bool_or(
        lower(split_part(split_part(media_url, '?', 1), '#', 1)) ~ '\.(mp4|webm|m3u8|mov|m4v)$'
      )
      FROM unnest(xvm."mediaUrls") AS media(media_url)
    ),
    false
  ),
  "imagePlaceholderSourceUrls" = ARRAY[]::TEXT[]
FROM "Investigation" i
JOIN "PostVersion" pv ON pv."id" = i."postVersionId"
JOIN "Post" p ON p."id" = pv."postId"
LEFT JOIN "Author" a ON a."id" = p."authorId"
LEFT JOIN "LesswrongVersionMeta" lwm ON lwm."postVersionId" = pv."id"
LEFT JOIN "XVersionMeta" xvm ON xvm."postVersionId" = pv."id"
LEFT JOIN "SubstackVersionMeta" svm ON svm."postVersionId" = pv."id"
LEFT JOIN "WikipediaVersionMeta" wvm ON wvm."postVersionId" = pv."id"
WHERE i."inputId" = ii."investigationId";

-- Investigations still waiting to run whose markdown contains image
-- placeholders would otherwise run with placeholders that match no image
-- (their source URLs were never stored). Run them on the flat-text input
-- instead, where images are placed by normalized text offset.
UPDATE "InvestigationInput" ii
SET "markdownSource" = 'NONE', "markdown" = NULL, "markdownRendererVersion" = NULL
FROM "Investigation" i
WHERE i."inputId" = ii."investigationId"
  AND i."status" IN ('PENDING', 'PROCESSING')
  AND ii."markdown" LIKE '%[IMAGE:%';

ALTER TABLE "InvestigationInput" ENABLE TRIGGER "reject_investigation_input_updates_trigger";

ALTER TABLE "InvestigationInput"
  ALTER COLUMN "postUrl" SET NOT NULL,
  ALTER COLUMN "hasVideo" SET NOT NULL;

ALTER TABLE "InvestigationInput"
  ADD CONSTRAINT "InvestigationInput_imagePlaceholderSourceUrls_not_null_chk"
  CHECK ("imagePlaceholderSourceUrls" IS NOT NULL);

ALTER TABLE "InvestigationInput"
  ADD CONSTRAINT "InvestigationInput_image_placeholders_require_markdown_chk"
  CHECK (
    "markdownSource" <> 'NONE'::"MarkdownSource"
    OR cardinality("imagePlaceholderSourceUrls") = 0
  );

-- ── 5. Source snapshot placeholders ─────────────────────────────────────────

ALTER TABLE "Source"
  DROP COLUMN "snapshotText",
  DROP COLUMN "snapshotHash",
  DROP COLUMN "retrievedAt";

-- ── 6. SubstackVersionMeta.serverHtmlBlobId ─────────────────────────────────

-- Substack versions can never be server-verified, so the server-HTML snapshot
-- check rejects serverVerifiedAt on them instead of looking for a column that
-- no longer exists.
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
  ELSIF post_platform = 'WIKIPEDIA' THEN
    SELECT (wvm."serverHtmlBlobId" IS NOT NULL)
    INTO has_server_html
    FROM "WikipediaVersionMeta" wvm
    WHERE wvm."postVersionId" = NEW."id";
  ELSIF post_platform = 'SUBSTACK' THEN
    RAISE EXCEPTION
      'Substack posts have no server-side verification; serverVerifiedAt must stay null (postVersionId=%)',
      NEW."id";
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

ALTER TABLE "SubstackVersionMeta" DROP CONSTRAINT "SubstackVersionMeta_serverHtmlBlobId_fkey";
ALTER TABLE "SubstackVersionMeta" DROP COLUMN "serverHtmlBlobId";

-- ── 7. Version-meta update policy trigger names ─────────────────────────────

ALTER FUNCTION "reject_lesswrong_version_meta_updates"()
  RENAME TO "enforce_lesswrong_version_meta_update_policy";
ALTER TRIGGER "reject_lesswrong_version_meta_updates_trigger" ON "LesswrongVersionMeta"
  RENAME TO "enforce_lesswrong_version_meta_update_policy_trigger";

ALTER FUNCTION "reject_substack_version_meta_updates"()
  RENAME TO "enforce_substack_version_meta_update_policy";
ALTER TRIGGER "reject_substack_version_meta_updates_trigger" ON "SubstackVersionMeta"
  RENAME TO "enforce_substack_version_meta_update_policy_trigger";

ALTER FUNCTION "reject_wikipedia_version_meta_updates"()
  RENAME TO "enforce_wikipedia_version_meta_update_policy";
ALTER TRIGGER "reject_wikipedia_version_meta_updates_trigger" ON "WikipediaVersionMeta"
  RENAME TO "enforce_wikipedia_version_meta_update_policy_trigger";
