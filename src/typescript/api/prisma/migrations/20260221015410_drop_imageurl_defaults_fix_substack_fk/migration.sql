-- DropForeignKey
ALTER TABLE "SubstackMeta" DROP CONSTRAINT "SubstackMeta_postId_fkey";

-- AlterTable
ALTER TABLE "LesswrongMeta" ALTER COLUMN "imageUrls" DROP DEFAULT;

-- AlterTable
ALTER TABLE "SubstackMeta" ALTER COLUMN "imageUrls" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "SubstackMeta" ADD CONSTRAINT "SubstackMeta_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
