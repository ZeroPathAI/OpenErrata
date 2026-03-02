-- ============================================================================
-- Migration 0019: Allow server HTML blob updates (latest-server-fetch-wins)
-- ============================================================================
--
-- The 0018 triggers only permitted serverHtmlBlobId to transition from NULL to
-- a non-null value. In practice the authoritative server API (LessWrong
-- GraphQL, Wikipedia Parse API) can return different raw HTML bytes for the
-- same post content across time due to API formatting drift, without the
-- normalized text (and therefore the PostVersion.contentHash) changing.
--
-- The application now stores the latest server-fetched HTML blob, replacing
-- the stored one when the bytes differ. Past investigations are unaffected —
-- each InvestigationInput row holds its own immutable markdown snapshot.
-- Client HTML retains first-write-wins (NULL → non-null only).
--
-- Change: serverHtmlBlobId guard relaxed from
--   (OLD IS NULL AND NEW IS NOT NULL) OR (NEW = OLD)
-- to
--   NEW IS NOT NULL OR OLD IS NULL
-- which additionally permits non-null → different non-null transitions.

CREATE OR REPLACE FUNCTION "reject_lesswrong_version_meta_updates"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    (NEW."serverHtmlBlobId" IS NOT NULL OR OLD."serverHtmlBlobId" IS NULL)
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

  RAISE EXCEPTION 'LesswrongVersionMeta is immutable; updates are not allowed except HTML blob enrichment (postVersionId=%)', NEW."postVersionId";
END;
$$;

CREATE OR REPLACE FUNCTION "reject_substack_version_meta_updates"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    (NEW."serverHtmlBlobId" IS NOT NULL OR OLD."serverHtmlBlobId" IS NULL)
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

  RAISE EXCEPTION 'SubstackVersionMeta is immutable; updates are not allowed except HTML blob enrichment (postVersionId=%)', NEW."postVersionId";
END;
$$;

CREATE OR REPLACE FUNCTION "reject_wikipedia_version_meta_updates"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    (NEW."serverHtmlBlobId" IS NOT NULL OR OLD."serverHtmlBlobId" IS NULL)
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

  RAISE EXCEPTION 'WikipediaVersionMeta is immutable; updates are not allowed except HTML blob enrichment (postVersionId=%)', NEW."postVersionId";
END;
$$;
