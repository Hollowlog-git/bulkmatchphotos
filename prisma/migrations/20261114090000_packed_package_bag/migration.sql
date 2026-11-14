-- AlterTable
ALTER TABLE "PackedPackage" ADD COLUMN "bagId" TEXT;

-- Every existing package is its own bag.
UPDATE "PackedPackage" SET "bagId" = "id" WHERE "bagId" IS NULL;
