-- Breaking release schema tightening.
--
-- 1. Drop unused PostVersionViewCredit table.
-- 2. Convert InvestigationInput.provenance and .markdownSource from TEXT to Prisma enums.
-- 3. Document why HTML blob presence CHECK constraints are intentionally not added for
--    SubstackVersionMeta and WikipediaVersionMeta.

-- ── 1. Drop PostVersionViewCredit ───────────────────────────────────────────

DROP TABLE IF EXISTS "PostVersionViewCredit";

-- ── 2. Convert provenance and markdownSource to native enums ────────────────

-- Re-create ContentProvenance (dropped by 0018_trust_model_and_schema_normalization
-- when InvestigationInput replaced the old PostVersion.contentProvenance column).
CREATE TYPE "ContentProvenance" AS ENUM ('SERVER_VERIFIED', 'CLIENT_FALLBACK');

-- Create the MarkdownSource enum type.
CREATE TYPE "MarkdownSource" AS ENUM ('SERVER_HTML', 'CLIENT_HTML', 'NONE');

-- Drop the old CHECK constraints that enforced valid values as TEXT.
ALTER TABLE "InvestigationInput"
  DROP CONSTRAINT IF EXISTS "InvestigationInput_provenance_chk";

ALTER TABLE "InvestigationInput"
  DROP CONSTRAINT IF EXISTS "InvestigationInput_markdownSource_chk";

-- Drop consistency CHECK constraints that reference markdownSource as TEXT;
-- they will be re-created below with enum-typed comparisons.
ALTER TABLE "InvestigationInput"
  DROP CONSTRAINT IF EXISTS "InvestigationInput_markdown_source_consistency_chk";

ALTER TABLE "InvestigationInput"
  DROP CONSTRAINT IF EXISTS "InvestigationInput_renderer_source_consistency_chk";

-- Convert the columns from TEXT to enum using an explicit USING cast.
ALTER TABLE "InvestigationInput"
  ALTER COLUMN "provenance"
    TYPE "ContentProvenance" USING "provenance"::"ContentProvenance";

ALTER TABLE "InvestigationInput"
  ALTER COLUMN "markdownSource"
    TYPE "MarkdownSource" USING "markdownSource"::"MarkdownSource";

-- Re-create the consistency CHECK constraints with enum-typed comparisons.
ALTER TABLE "InvestigationInput"
  ADD CONSTRAINT "InvestigationInput_markdown_source_consistency_chk"
  CHECK (("markdownSource" = 'NONE'::"MarkdownSource") = (markdown IS NULL));

ALTER TABLE "InvestigationInput"
  ADD CONSTRAINT "InvestigationInput_renderer_source_consistency_chk"
  CHECK (("markdownSource" = 'NONE'::"MarkdownSource") = ("markdownRendererVersion" IS NULL));

-- ── 3. HTML blob presence CHECK constraints ──────────────────────────────────
-- LesswrongVersionMeta already has this from migration 0018.
-- Substack has no server-side canonical fetch, so both blob IDs can
-- legitimately be NULL when the extension omits oversized htmlContent.
-- Wikipedia's server fetch can also fail while the client omits oversized HTML.
-- Historical rows from migration 0018 backfill have both blob IDs as NULL.
-- These constraints are therefore NOT added for Substack and Wikipedia.
