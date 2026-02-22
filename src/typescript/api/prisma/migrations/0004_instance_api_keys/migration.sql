CREATE TABLE "InstanceApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstanceApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InstanceApiKey_keyHash_key" ON "InstanceApiKey"("keyHash");
CREATE INDEX "InstanceApiKey_name_idx" ON "InstanceApiKey"("name");
CREATE INDEX "InstanceApiKey_revokedAt_idx" ON "InstanceApiKey"("revokedAt");
