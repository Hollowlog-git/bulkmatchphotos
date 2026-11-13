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
