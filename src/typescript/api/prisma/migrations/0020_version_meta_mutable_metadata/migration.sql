-- ============================================================================
-- Migration 0020: Relax version meta triggers to allow mutable metadata updates
-- ============================================================================
--
-- Migration 0019 relaxed serverHtmlBlobId to allow non-null → non-null updates
-- but kept all other metadata fields immutable.  In practice, many fields are
-- mutable post-level metadata that can change independently of the
-- PostVersion.contentHash:
--
--   LessWrong: slug + title change on post rename; karma, tags, author info
--              are all mutable on the platform.
--   Substack:  likeCount, commentCount change over time.
--   Wikipedia: displayTitle can vary across API responses.
--
-- The application now stores the latest metadata snapshot on each
-- re-registration.  Past investigations are unaffected — each
-- InvestigationInput row holds its own immutable markdown snapshot.
--
-- New trigger contract (same for all three tables):
--   IMMUTABLE:        postVersionId, createdAt
--   FIRST-WRITE-WINS: clientHtmlBlobId (NULL → non-null only)
--   LATEST-WINS:      everything else

CREATE OR REPLACE FUNCTION "reject_lesswrong_version_meta_updates"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    NEW."postVersionId" IS NOT DISTINCT FROM OLD."postVersionId"
    AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
    AND (
      (OLD."clientHtmlBlobId" IS NULL AND NEW."clientHtmlBlobId" IS NOT NULL)
      OR NEW."clientHtmlBlobId" IS NOT DISTINCT FROM OLD."clientHtmlBlobId"
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'LesswrongVersionMeta update violates immutability constraints (postVersionId=%)', NEW."postVersionId";
END;
$$;

CREATE OR REPLACE FUNCTION "reject_substack_version_meta_updates"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    NEW."postVersionId" IS NOT DISTINCT FROM OLD."postVersionId"
    AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
    AND (
      (OLD."clientHtmlBlobId" IS NULL AND NEW."clientHtmlBlobId" IS NOT NULL)
      OR NEW."clientHtmlBlobId" IS NOT DISTINCT FROM OLD."clientHtmlBlobId"
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SubstackVersionMeta update violates immutability constraints (postVersionId=%)', NEW."postVersionId";
END;
$$;

CREATE OR REPLACE FUNCTION "reject_wikipedia_version_meta_updates"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    NEW."postVersionId" IS NOT DISTINCT FROM OLD."postVersionId"
    AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
    AND (
      (OLD."clientHtmlBlobId" IS NULL AND NEW."clientHtmlBlobId" IS NOT NULL)
      OR NEW."clientHtmlBlobId" IS NOT DISTINCT FROM OLD."clientHtmlBlobId"
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'WikipediaVersionMeta update violates immutability constraints (postVersionId=%)', NEW."postVersionId";
END;
$$;
