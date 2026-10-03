-- Two audit-truthfulness changes:
--
-- 1. Investigation.model stops being an InvestigationModel enum value guessed
--    at queue time. It becomes the provider model id the stage-1 fact-check
--    requests were actually sent to, recorded at completion: set iff
--    status = COMPLETE (INV-INV-MODEL-AT-COMPLETION). Existing COMPLETE rows
--    take the requestModel of their SUCCEEDED attempt; every other row becomes
--    NULL. A COMPLETE investigation without exactly one SUCCEEDED attempt has
--    no truthful value, so the migration aborts instead of inventing one.
--
-- 2. InvestigationAttempt audits move to one InvestigationAttemptRequest row
--    per provider request (fact-check rounds, per-claim validations), each
--    with its own response. Existing attempts squashed every request into one
--    record that cannot be split truthfully, so each becomes a single
--    LEGACY_COMBINED request (with one response when it had one) and keeps its
--    children unchanged. Dropped legacy data: responseOutputText (the SDK's
--    concatenation of the last response's output_text parts, which remain as
--    text parts) and tool-call capturedAt/providerStartedAt/providerCompletedAt
--    (parse-time stamps and always-null guesses); tool-call id/type/status
--    columns duplicated their output item's and are dropped.

-- ── 1a. Preconditions ────────────────────────────────────────────────────────

DO $$
DECLARE
  offending_investigation_ids TEXT;
  offending_attempt_ids TEXT;
BEGIN
  SELECT string_agg(i."id", ', ' ORDER BY i."id")
  INTO offending_investigation_ids
  FROM "Investigation" i
  WHERE i."status" = 'COMPLETE'
    AND (
      SELECT COUNT(*)
      FROM "InvestigationAttempt" a
      WHERE a."investigationId" = i."id"
        AND a."outcome" = 'SUCCEEDED'
    ) <> 1;

  IF offending_investigation_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot record Investigation.model: COMPLETE investigations without exactly one SUCCEEDED InvestigationAttempt have no recorded request model: %',
      offending_investigation_ids;
  END IF;

  SELECT string_agg(a."id", ', ' ORDER BY a."id")
  INTO offending_attempt_ids
  FROM "InvestigationAttempt" a
  WHERE (
      a."responseId" IS NULL
      AND (
        a."responseStatus" IS NOT NULL
        OR a."responseModelVersion" IS NOT NULL
        OR a."responseOutputText" IS NOT NULL
        OR EXISTS (SELECT 1 FROM "InvestigationAttemptOutputItem" o WHERE o."attemptId" = a."id")
        OR EXISTS (SELECT 1 FROM "InvestigationAttemptUsage" u WHERE u."attemptId" = a."id")
      )
    )
    OR (a."responseId" IS NOT NULL AND a."responseModelVersion" IS NULL);

  IF offending_attempt_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot migrate InvestigationAttempt audits: attempts with a partially recorded response (response data without responseId, or responseId without responseModelVersion): %',
      offending_attempt_ids;
  END IF;
END
$$;

-- ── 1b. Investigation.model: recorded at completion ─────────────────────────

ALTER TABLE "Investigation" ALTER COLUMN "model" DROP NOT NULL;
ALTER TABLE "Investigation" ALTER COLUMN "model" TYPE TEXT USING NULL;

UPDATE "Investigation" i
SET "model" = a."requestModel"
FROM "InvestigationAttempt" a
WHERE a."investigationId" = i."id"
  AND a."outcome" = 'SUCCEEDED'
  AND i."status" = 'COMPLETE';

ALTER TABLE "Investigation"
  ADD CONSTRAINT "Investigation_model_consistency_check"
  CHECK (("status" = 'COMPLETE') = ("model" IS NOT NULL));

DROP TYPE "InvestigationModel";

-- ── 2a. Per-request audit tables ────────────────────────────────────────────

CREATE TYPE "InvestigationAttemptRequestKind" AS ENUM ('FACT_CHECK_ROUND', 'CLAIM_VALIDATION', 'LEGACY_COMBINED');

CREATE TABLE "InvestigationAttemptRequest" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "kind" "InvestigationAttemptRequestKind" NOT NULL,
    "factCheckRound" INTEGER,
    "claimIndex" INTEGER,
    "model" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "previousResponseId" TEXT,
    "reasoningEffort" TEXT,
    "reasoningSummary" TEXT,
    "include" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestigationAttemptRequest_pkey" PRIMARY KEY ("id"),
    -- INV-ATTEMPT-REQUEST-SUBJECT
    CONSTRAINT "InvestigationAttemptRequest_subject_check" CHECK (
      ("factCheckRound" IS NOT NULL) = ("kind" = 'FACT_CHECK_ROUND')
      AND ("claimIndex" IS NOT NULL) = ("kind" = 'CLAIM_VALIDATION')
      AND COALESCE("factCheckRound", 0) >= 0
      AND COALESCE("claimIndex", 0) >= 0
    )
);

CREATE TABLE "InvestigationAttemptResponse" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "providerResponseId" TEXT NOT NULL,
    "status" TEXT,
    "modelVersion" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestigationAttemptResponse_pkey" PRIMARY KEY ("id")
);

-- ── 2b. Legacy attempts → one LEGACY_COMBINED request each ─────────────────
-- The legacy request and response reuse their attempt's id (distinct tables),
-- which lets the children below be re-parented without a mapping table.

INSERT INTO "InvestigationAttemptRequest" (
  "id", "attemptId", "kind", "factCheckRound", "claimIndex", "model", "instructions", "input",
  "previousResponseId", "reasoningEffort", "reasoningSummary", "include", "createdAt"
)
SELECT
  a."id", a."id", 'LEGACY_COMBINED', NULL, NULL, a."requestModel", a."requestInstructions",
  to_jsonb(a."requestInput"), NULL, a."requestReasoningEffort", a."requestReasoningSummary",
  -- Legacy requests sent no `include` parameter.
  ARRAY[]::TEXT[], a."createdAt"
FROM "InvestigationAttempt" a;

INSERT INTO "InvestigationAttemptResponse" (
  "id", "requestId", "providerResponseId", "status", "modelVersion", "receivedAt", "createdAt"
)
SELECT a."id", a."id", a."responseId", a."responseStatus", a."responseModelVersion", NULL, a."createdAt"
FROM "InvestigationAttempt" a
WHERE a."responseId" IS NOT NULL;

ALTER TABLE "InvestigationAttemptRequestedTool" DROP CONSTRAINT "InvestigationAttemptRequestedTool_attemptId_fkey";
DROP INDEX "InvestigationAttemptRequestedTool_attemptId_idx";
DROP INDEX "InvestigationAttemptRequestedTool_attemptId_requestOrder_key";
ALTER TABLE "InvestigationAttemptRequestedTool" RENAME COLUMN "attemptId" TO "requestId";

ALTER TABLE "InvestigationAttemptOutputItem" DROP CONSTRAINT "InvestigationAttemptOutputItem_attemptId_fkey";
DROP INDEX "InvestigationAttemptOutputItem_attemptId_idx";
DROP INDEX "InvestigationAttemptOutputItem_attemptId_outputIndex_key";
ALTER TABLE "InvestigationAttemptOutputItem" RENAME COLUMN "attemptId" TO "responseId";

ALTER TABLE "InvestigationAttemptUsage" DROP CONSTRAINT "InvestigationAttemptUsage_attemptId_fkey";
DROP INDEX "InvestigationAttemptUsage_attemptId_key";
ALTER TABLE "InvestigationAttemptUsage" RENAME COLUMN "attemptId" TO "responseId";

ALTER TABLE "InvestigationAttemptToolCall" DROP CONSTRAINT "InvestigationAttemptToolCall_attemptId_fkey";
DROP INDEX "InvestigationAttemptToolCall_attemptId_idx";
DROP INDEX "InvestigationAttemptToolCall_attemptId_outputIndex_key";
ALTER TABLE "InvestigationAttemptToolCall"
  DROP COLUMN "attemptId",
  DROP COLUMN "outputIndex",
  DROP COLUMN "providerToolCallId",
  DROP COLUMN "toolType",
  DROP COLUMN "status",
  DROP COLUMN "capturedAt",
  DROP COLUMN "providerStartedAt",
  DROP COLUMN "providerCompletedAt";

ALTER TABLE "InvestigationAttempt"
  DROP COLUMN "requestModel",
  DROP COLUMN "requestInstructions",
  DROP COLUMN "requestInput",
  DROP COLUMN "requestReasoningEffort",
  DROP COLUMN "requestReasoningSummary",
  DROP COLUMN "responseId",
  DROP COLUMN "responseStatus",
  DROP COLUMN "responseModelVersion",
  DROP COLUMN "responseOutputText";

-- ── 2c. Indexes and foreign keys ────────────────────────────────────────────

CREATE INDEX "InvestigationAttemptRequest_attemptId_idx" ON "InvestigationAttemptRequest"("attemptId");
CREATE UNIQUE INDEX "InvestigationAttemptRequest_attemptId_factCheckRound_key" ON "InvestigationAttemptRequest"("attemptId", "factCheckRound");
CREATE UNIQUE INDEX "InvestigationAttemptRequest_attemptId_claimIndex_key" ON "InvestigationAttemptRequest"("attemptId", "claimIndex");
CREATE UNIQUE INDEX "InvestigationAttemptResponse_requestId_key" ON "InvestigationAttemptResponse"("requestId");
CREATE INDEX "InvestigationAttemptOutputItem_responseId_idx" ON "InvestigationAttemptOutputItem"("responseId");
CREATE UNIQUE INDEX "InvestigationAttemptOutputItem_responseId_outputIndex_key" ON "InvestigationAttemptOutputItem"("responseId", "outputIndex");
CREATE INDEX "InvestigationAttemptRequestedTool_requestId_idx" ON "InvestigationAttemptRequestedTool"("requestId");
CREATE UNIQUE INDEX "InvestigationAttemptRequestedTool_requestId_requestOrder_key" ON "InvestigationAttemptRequestedTool"("requestId", "requestOrder");
CREATE UNIQUE INDEX "InvestigationAttemptUsage_responseId_key" ON "InvestigationAttemptUsage"("responseId");

ALTER TABLE "InvestigationAttemptRequest" ADD CONSTRAINT "InvestigationAttemptRequest_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "InvestigationAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvestigationAttemptRequestedTool" ADD CONSTRAINT "InvestigationAttemptRequestedTool_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "InvestigationAttemptRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvestigationAttemptResponse" ADD CONSTRAINT "InvestigationAttemptResponse_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "InvestigationAttemptRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvestigationAttemptOutputItem" ADD CONSTRAINT "InvestigationAttemptOutputItem_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "InvestigationAttemptResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvestigationAttemptUsage" ADD CONSTRAINT "InvestigationAttemptUsage_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "InvestigationAttemptResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
