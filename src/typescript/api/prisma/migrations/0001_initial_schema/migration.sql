-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('LESSWRONG', 'X', 'SUBSTACK');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "ContentProvenance" AS ENUM ('SERVER_VERIFIED', 'CLIENT_FALLBACK');

-- CreateEnum
CREATE TYPE "InvestigationProvider" AS ENUM ('OPENAI', 'ANTHROPIC');

-- CreateEnum
CREATE TYPE "InvestigationModel" AS ENUM ('OPENAI_GPT_5', 'OPENAI_GPT_5_MINI', 'ANTHROPIC_CLAUDE_SONNET', 'ANTHROPIC_CLAUDE_OPUS');

-- CreateEnum
CREATE TYPE "InvestigationAttemptOutcome" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "Post" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "authorId" TEXT,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueViewScore" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "latestContentHash" TEXT,
    "latestContentText" TEXT,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostViewCredit" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "viewerKey" TEXT NOT NULL,
    "ipRangeKey" TEXT NOT NULL,
    "bucketDay" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostViewCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Author" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "platformUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Author_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LesswrongMeta" (
    "postId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "htmlContent" TEXT NOT NULL,
    "imageUrls" TEXT[],
    "wordCount" INTEGER,
    "karma" INTEGER,
    "authorName" TEXT NOT NULL,
    "authorSlug" TEXT,
    "tags" TEXT[],
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "LesswrongMeta_pkey" PRIMARY KEY ("postId")
);

-- CreateTable
CREATE TABLE "XMeta" (
    "postId" TEXT NOT NULL,
    "tweetId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "authorHandle" TEXT NOT NULL,
    "authorDisplayName" TEXT,
    "mediaUrls" TEXT[],
    "likeCount" INTEGER,
    "retweetCount" INTEGER,
    "postedAt" TIMESTAMP(3),

    CONSTRAINT "XMeta_pkey" PRIMARY KEY ("postId")
);

-- CreateTable
CREATE TABLE "SubstackMeta" (
    "postId" TEXT NOT NULL,
    "substackPostId" TEXT NOT NULL,
    "publicationSubdomain" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "imageUrls" TEXT[],
    "authorName" TEXT NOT NULL,
    "authorSubstackHandle" TEXT,
    "publishedAt" TIMESTAMP(3),
    "likeCount" INTEGER,
    "commentCount" INTEGER,

    CONSTRAINT "SubstackMeta_pkey" PRIMARY KEY ("postId")
);

-- CreateTable
CREATE TABLE "Prompt" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Investigation" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "contentText" TEXT NOT NULL,
    "contentProvenance" "ContentProvenance" NOT NULL,
    "fetchFailureReason" TEXT,
    "serverVerifiedAt" TIMESTAMP(3),
    "status" "CheckStatus" NOT NULL,
    "promptId" TEXT NOT NULL,
    "provider" "InvestigationProvider" NOT NULL,
    "model" "InvestigationModel" NOT NULL,
    "modelVersion" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Investigation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationRun" (
    "id" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestigationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationOpenAiKeySource" (
    "runId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestigationOpenAiKeySource_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "ImageBlob" (
    "id" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImageBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationImage" (
    "investigationId" TEXT NOT NULL,
    "imageBlobId" TEXT NOT NULL,
    "imageOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestigationImage_pkey" PRIMARY KEY ("investigationId","imageBlobId")
);

-- CreateTable
CREATE TABLE "InvestigationAttempt" (
    "id" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "outcome" "InvestigationAttemptOutcome" NOT NULL,
    "requestModel" TEXT NOT NULL,
    "requestInstructions" TEXT NOT NULL,
    "requestInput" TEXT NOT NULL,
    "requestReasoningEffort" TEXT,
    "requestReasoningSummary" TEXT,
    "responseId" TEXT,
    "responseStatus" TEXT,
    "responseModelVersion" TEXT,
    "responseOutputText" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestigationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationAttemptRequestedTool" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "requestOrder" INTEGER NOT NULL,
    "toolType" TEXT NOT NULL,
    "rawDefinition" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestigationAttemptRequestedTool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationAttemptOutputItem" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "outputIndex" INTEGER NOT NULL,
    "providerItemId" TEXT,
    "itemType" TEXT NOT NULL,
    "itemStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestigationAttemptOutputItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationAttemptOutputTextPart" (
    "id" TEXT NOT NULL,
    "outputItemId" TEXT NOT NULL,
    "partIndex" INTEGER NOT NULL,
    "partType" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestigationAttemptOutputTextPart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationAttemptOutputTextAnnotation" (
    "id" TEXT NOT NULL,
    "textPartId" TEXT NOT NULL,
    "annotationIndex" INTEGER NOT NULL,
    "annotationType" TEXT NOT NULL,
    "startIndex" INTEGER,
    "endIndex" INTEGER,
    "url" TEXT,
    "title" TEXT,
    "fileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestigationAttemptOutputTextAnnotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationAttemptReasoningSummary" (
    "id" TEXT NOT NULL,
    "outputItemId" TEXT NOT NULL,
    "summaryIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestigationAttemptReasoningSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationAttemptToolCall" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "outputItemId" TEXT NOT NULL,
    "outputIndex" INTEGER NOT NULL,
    "providerToolCallId" TEXT,
    "toolType" TEXT NOT NULL,
    "status" TEXT,
    "rawPayload" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "providerStartedAt" TIMESTAMP(3),
    "providerCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestigationAttemptToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationAttemptUsage" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "totalTokens" INTEGER NOT NULL,
    "cachedInputTokens" INTEGER,
    "reasoningOutputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestigationAttemptUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationAttemptError" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "errorName" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "statusCode" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestigationAttemptError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorroborationCredit" (
    "id" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "reporterKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorroborationCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "snapshotText" TEXT,
    "snapshotHash" TEXT,
    "retrievedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Post_viewCount_idx" ON "Post"("viewCount");

-- CreateIndex
CREATE INDEX "Post_uniqueViewScore_idx" ON "Post"("uniqueViewScore");

-- CreateIndex
CREATE INDEX "Post_authorId_idx" ON "Post"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "Post_platform_externalId_key" ON "Post"("platform", "externalId");

-- CreateIndex
CREATE INDEX "PostViewCredit_postId_bucketDay_idx" ON "PostViewCredit"("postId", "bucketDay");

-- CreateIndex
CREATE INDEX "PostViewCredit_postId_ipRangeKey_bucketDay_idx" ON "PostViewCredit"("postId", "ipRangeKey", "bucketDay");

-- CreateIndex
CREATE UNIQUE INDEX "PostViewCredit_postId_viewerKey_bucketDay_key" ON "PostViewCredit"("postId", "viewerKey", "bucketDay");

-- CreateIndex
CREATE UNIQUE INDEX "Author_platform_platformUserId_key" ON "Author"("platform", "platformUserId");

-- CreateIndex
CREATE UNIQUE INDEX "LesswrongMeta_slug_key" ON "LesswrongMeta"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "XMeta_tweetId_key" ON "XMeta"("tweetId");

-- CreateIndex
CREATE UNIQUE INDEX "SubstackMeta_substackPostId_key" ON "SubstackMeta"("substackPostId");

-- CreateIndex
CREATE UNIQUE INDEX "SubstackMeta_publicationSubdomain_slug_key" ON "SubstackMeta"("publicationSubdomain", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Prompt_version_key" ON "Prompt"("version");

-- CreateIndex
CREATE UNIQUE INDEX "Prompt_hash_key" ON "Prompt"("hash");

-- CreateIndex
CREATE INDEX "Investigation_postId_status_idx" ON "Investigation"("postId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Investigation_postId_contentHash_key" ON "Investigation"("postId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "InvestigationRun_investigationId_key" ON "InvestigationRun"("investigationId");

-- CreateIndex
CREATE INDEX "InvestigationRun_leaseExpiresAt_idx" ON "InvestigationRun"("leaseExpiresAt");

-- CreateIndex
CREATE INDEX "InvestigationOpenAiKeySource_expiresAt_idx" ON "InvestigationOpenAiKeySource"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImageBlob_contentHash_key" ON "ImageBlob"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "ImageBlob_storageKey_key" ON "ImageBlob"("storageKey");

-- CreateIndex
CREATE INDEX "InvestigationImage_imageBlobId_idx" ON "InvestigationImage"("imageBlobId");

-- CreateIndex
CREATE UNIQUE INDEX "InvestigationImage_investigationId_imageOrder_key" ON "InvestigationImage"("investigationId", "imageOrder");

-- CreateIndex
CREATE INDEX "InvestigationAttempt_investigationId_startedAt_idx" ON "InvestigationAttempt"("investigationId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InvestigationAttempt_investigationId_attemptNumber_key" ON "InvestigationAttempt"("investigationId", "attemptNumber");

-- CreateIndex
CREATE INDEX "InvestigationAttemptRequestedTool_attemptId_idx" ON "InvestigationAttemptRequestedTool"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "InvestigationAttemptRequestedTool_attemptId_requestOrder_key" ON "InvestigationAttemptRequestedTool"("attemptId", "requestOrder");

-- CreateIndex
CREATE INDEX "InvestigationAttemptOutputItem_attemptId_idx" ON "InvestigationAttemptOutputItem"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "InvestigationAttemptOutputItem_attemptId_outputIndex_key" ON "InvestigationAttemptOutputItem"("attemptId", "outputIndex");

-- CreateIndex
CREATE INDEX "InvestigationAttemptOutputTextPart_outputItemId_idx" ON "InvestigationAttemptOutputTextPart"("outputItemId");

-- CreateIndex
CREATE UNIQUE INDEX "InvestigationAttemptOutputTextPart_outputItemId_partIndex_key" ON "InvestigationAttemptOutputTextPart"("outputItemId", "partIndex");

-- CreateIndex
CREATE INDEX "InvestigationAttemptOutputTextAnnotation_textPartId_idx" ON "InvestigationAttemptOutputTextAnnotation"("textPartId");

-- CreateIndex
CREATE UNIQUE INDEX "IATextAnn_textPart_annotation_uq" ON "InvestigationAttemptOutputTextAnnotation"("textPartId", "annotationIndex");

-- CreateIndex
CREATE INDEX "InvestigationAttemptReasoningSummary_outputItemId_idx" ON "InvestigationAttemptReasoningSummary"("outputItemId");

-- CreateIndex
CREATE UNIQUE INDEX "IAReasoning_output_summary_uq" ON "InvestigationAttemptReasoningSummary"("outputItemId", "summaryIndex");

-- CreateIndex
CREATE INDEX "InvestigationAttemptToolCall_attemptId_idx" ON "InvestigationAttemptToolCall"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "InvestigationAttemptToolCall_attemptId_outputIndex_key" ON "InvestigationAttemptToolCall"("attemptId", "outputIndex");

-- CreateIndex
CREATE UNIQUE INDEX "InvestigationAttemptToolCall_outputItemId_key" ON "InvestigationAttemptToolCall"("outputItemId");

-- CreateIndex
CREATE UNIQUE INDEX "InvestigationAttemptUsage_attemptId_key" ON "InvestigationAttemptUsage"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "InvestigationAttemptError_attemptId_key" ON "InvestigationAttemptError"("attemptId");

-- CreateIndex
CREATE INDEX "CorroborationCredit_investigationId_idx" ON "CorroborationCredit"("investigationId");

-- CreateIndex
CREATE UNIQUE INDEX "CorroborationCredit_investigationId_reporterKey_key" ON "CorroborationCredit"("investigationId", "reporterKey");

-- CreateIndex
CREATE INDEX "Claim_investigationId_idx" ON "Claim"("investigationId");

-- CreateIndex
CREATE INDEX "Source_claimId_idx" ON "Source"("claimId");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Author"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostViewCredit" ADD CONSTRAINT "PostViewCredit_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LesswrongMeta" ADD CONSTRAINT "LesswrongMeta_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XMeta" ADD CONSTRAINT "XMeta_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubstackMeta" ADD CONSTRAINT "SubstackMeta_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investigation" ADD CONSTRAINT "Investigation_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investigation" ADD CONSTRAINT "Investigation_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "Prompt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationRun" ADD CONSTRAINT "InvestigationRun_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationOpenAiKeySource" ADD CONSTRAINT "InvestigationOpenAiKeySource_runId_fkey" FOREIGN KEY ("runId") REFERENCES "InvestigationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationImage" ADD CONSTRAINT "InvestigationImage_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationImage" ADD CONSTRAINT "InvestigationImage_imageBlobId_fkey" FOREIGN KEY ("imageBlobId") REFERENCES "ImageBlob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationAttempt" ADD CONSTRAINT "InvestigationAttempt_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationAttemptRequestedTool" ADD CONSTRAINT "InvestigationAttemptRequestedTool_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "InvestigationAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationAttemptOutputItem" ADD CONSTRAINT "InvestigationAttemptOutputItem_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "InvestigationAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationAttemptOutputTextPart" ADD CONSTRAINT "InvestigationAttemptOutputTextPart_outputItemId_fkey" FOREIGN KEY ("outputItemId") REFERENCES "InvestigationAttemptOutputItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationAttemptOutputTextAnnotation" ADD CONSTRAINT "InvestigationAttemptOutputTextAnnotation_textPartId_fkey" FOREIGN KEY ("textPartId") REFERENCES "InvestigationAttemptOutputTextPart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationAttemptReasoningSummary" ADD CONSTRAINT "InvestigationAttemptReasoningSummary_outputItemId_fkey" FOREIGN KEY ("outputItemId") REFERENCES "InvestigationAttemptOutputItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationAttemptToolCall" ADD CONSTRAINT "InvestigationAttemptToolCall_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "InvestigationAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationAttemptToolCall" ADD CONSTRAINT "InvestigationAttemptToolCall_outputItemId_fkey" FOREIGN KEY ("outputItemId") REFERENCES "InvestigationAttemptOutputItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationAttemptUsage" ADD CONSTRAINT "InvestigationAttemptUsage_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "InvestigationAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationAttemptError" ADD CONSTRAINT "InvestigationAttemptError_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "InvestigationAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorroborationCredit" ADD CONSTRAINT "CorroborationCredit_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
