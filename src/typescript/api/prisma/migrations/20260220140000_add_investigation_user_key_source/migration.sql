CREATE TABLE "InvestigationUserKeySource" (
    "investigationId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestigationUserKeySource_pkey" PRIMARY KEY ("investigationId")
);

CREATE INDEX "InvestigationUserKeySource_expiresAt_idx" ON "InvestigationUserKeySource"("expiresAt");

ALTER TABLE "InvestigationUserKeySource"
ADD CONSTRAINT "InvestigationUserKeySource_investigationId_fkey"
FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
