CREATE TABLE "InvestigationRun" (
    "id" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "status" "CheckStatus" NOT NULL,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestigationRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InvestigationRun_investigationId_key" ON "InvestigationRun"("investigationId");
CREATE INDEX "InvestigationRun_status_leaseExpiresAt_idx" ON "InvestigationRun"("status", "leaseExpiresAt");

ALTER TABLE "InvestigationRun"
ADD CONSTRAINT "InvestigationRun_investigationId_fkey"
FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "InvestigationRun" (
    "id",
    "investigationId",
    "status",
    "queuedAt",
    "startedAt",
    "heartbeatAt",
    "completedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    'run_' || substr(md5(i."id" || random()::text || clock_timestamp()::text), 1, 24),
    i."id",
    i."status",
    CASE WHEN i."status" = 'PENDING' THEN NOW() ELSE NULL END,
    CASE WHEN i."status" = 'PROCESSING' THEN NOW() ELSE NULL END,
    CASE WHEN i."status" = 'PROCESSING' THEN NOW() ELSE NULL END,
    CASE WHEN i."status" IN ('COMPLETE', 'FAILED') THEN i."updatedAt" ELSE NULL END,
    NOW(),
    NOW()
FROM "Investigation" i
LEFT JOIN "InvestigationRun" r
  ON r."investigationId" = i."id"
WHERE r."id" IS NULL
  AND i."status" IN ('PENDING', 'PROCESSING');

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

CREATE INDEX "InvestigationOpenAiKeySource_expiresAt_idx" ON "InvestigationOpenAiKeySource"("expiresAt");

ALTER TABLE "InvestigationOpenAiKeySource"
ADD CONSTRAINT "InvestigationOpenAiKeySource_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "InvestigationRun"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

DROP TABLE "InvestigationUserKeySource";
