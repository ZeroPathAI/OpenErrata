ALTER TYPE "Platform" ADD VALUE IF NOT EXISTS 'WIKIPEDIA';

CREATE TABLE "WikipediaMeta" (
  "postId" TEXT NOT NULL,
  "pageId" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "displayTitle" TEXT,
  "revisionId" TEXT NOT NULL,
  "lastModifiedAt" TIMESTAMP(3),
  "imageUrls" TEXT[],

  CONSTRAINT "WikipediaMeta_pkey" PRIMARY KEY ("postId"),
  CONSTRAINT "WikipediaMeta_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "Post"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WikipediaMeta_language_pageId_key"
  ON "WikipediaMeta"("language", "pageId");

CREATE UNIQUE INDEX "WikipediaMeta_language_title_key"
  ON "WikipediaMeta"("language", "title");
