-- AlterTable
ALTER TABLE "LesswrongMeta"
ADD COLUMN "imageUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

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

-- CreateIndex
CREATE UNIQUE INDEX "ImageBlob_contentHash_key" ON "ImageBlob"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "ImageBlob_storageKey_key" ON "ImageBlob"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "InvestigationImage_investigationId_imageOrder_key" ON "InvestigationImage"("investigationId", "imageOrder");

-- CreateIndex
CREATE INDEX "InvestigationImage_imageBlobId_idx" ON "InvestigationImage"("imageBlobId");

-- AddForeignKey
ALTER TABLE "InvestigationImage"
ADD CONSTRAINT "InvestigationImage_investigationId_fkey"
FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationImage"
ADD CONSTRAINT "InvestigationImage_imageBlobId_fkey"
FOREIGN KEY ("imageBlobId") REFERENCES "ImageBlob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
