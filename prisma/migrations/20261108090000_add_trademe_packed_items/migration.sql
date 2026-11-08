-- CreateTable
CREATE TABLE "TradeMePackedItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "packedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "TradeMePackedItem_shop_purchaseId_key" ON "TradeMePackedItem"("shop", "purchaseId");

-- CreateIndex
CREATE INDEX "TradeMePackedItem_shop_packedAt_idx" ON "TradeMePackedItem"("shop", "packedAt");
