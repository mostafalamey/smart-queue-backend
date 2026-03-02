-- CreateTable
CREATE TABLE "TransferReason" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransferReason_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransferReason_hospitalId_isActive_sortOrder_idx" ON "TransferReason"("hospitalId", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "TransferReason_hospitalId_nameEn_key" ON "TransferReason"("hospitalId", "nameEn");

-- AddForeignKey
ALTER TABLE "TransferReason" ADD CONSTRAINT "TransferReason_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;
