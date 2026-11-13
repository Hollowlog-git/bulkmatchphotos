-- CreateTable
CREATE TABLE "PackedOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "packedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "PackedOrder_shop_orderId_key" ON "PackedOrder"("shop", "orderId");

-- CreateIndex
CREATE INDEX "PackedOrder_shop_packedAt_idx" ON "PackedOrder"("shop", "packedAt");

-- CreateTable
CREATE TABLE "PackedPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "packedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shopifyOrderIds" TEXT NOT NULL,
    "purchaseIds" TEXT NOT NULL,
    "snapshot" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "PackedPackage_shop_packedAt_idx" ON "PackedPackage"("shop", "packedAt");
