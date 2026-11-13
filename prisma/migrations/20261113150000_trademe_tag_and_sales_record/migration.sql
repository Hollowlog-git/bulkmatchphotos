-- AlterTable
ALTER TABLE "PackedOrder" ADD COLUMN "hasTradeMeTag" BOOLEAN;

-- AlterTable
ALTER TABLE "PackEvent" ADD COLUMN "salesRecordId" TEXT;
