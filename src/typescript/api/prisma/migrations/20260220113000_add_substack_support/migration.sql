-- AlterEnum
ALTER TYPE "Platform" ADD VALUE 'SUBSTACK';

-- CreateTable
CREATE TABLE "SubstackMeta" (
    "postId" TEXT NOT NULL,
    "substackPostId" TEXT NOT NULL,
    "publicationSubdomain" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "imageUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "authorName" TEXT NOT NULL,
    "authorSubstackHandle" TEXT,
    "publishedAt" TIMESTAMP(3),
    "likeCount" INTEGER,
    "commentCount" INTEGER,

    CONSTRAINT "SubstackMeta_pkey" PRIMARY KEY ("postId")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubstackMeta_substackPostId_key" ON "SubstackMeta"("substackPostId");

-- CreateIndex
CREATE UNIQUE INDEX "SubstackMeta_publicationSubdomain_slug_key" ON "SubstackMeta"("publicationSubdomain", "slug");

-- AddForeignKey
ALTER TABLE "SubstackMeta"
ADD CONSTRAINT "SubstackMeta_postId_fkey"
FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
