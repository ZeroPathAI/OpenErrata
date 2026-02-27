CREATE TABLE "PostImageOccurrence" (
  "id" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "originalIndex" INTEGER NOT NULL,
  "normalizedTextOffset" INTEGER NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "captionText" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PostImageOccurrence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PostImageOccurrence_postId_originalIndex_key"
  ON "PostImageOccurrence"("postId", "originalIndex");

CREATE INDEX "PostImageOccurrence_postId_normalizedTextOffset_originalIndex_idx"
  ON "PostImageOccurrence"("postId", "normalizedTextOffset", "originalIndex");

ALTER TABLE "PostImageOccurrence"
  ADD CONSTRAINT "PostImageOccurrence_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
