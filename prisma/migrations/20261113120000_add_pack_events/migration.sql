-- AlterTable
ALTER TABLE "PackedOrder" ADD COLUMN "channelAppId" TEXT;
ALTER TABLE "PackedOrder" ADD COLUMN "channelHandle" TEXT;
ALTER TABLE "PackedOrder" ADD COLUMN "channelName" TEXT;

-- CreateTable
CREATE TABLE "PackEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "packageId" TEXT,
    "purchaseId" TEXT,
    "groupKey" TEXT,
    "quantity" INTEGER,
    "orderId" TEXT,
    "orderName" TEXT,
    "lineItems" TEXT,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "PackEvent_shop_id_idx" ON "PackEvent"("shop", "id");

-- Backfill: every Trade Me purchase already recorded as packed becomes a
-- "packed" event, oldest first, so a client starting from the beginning of
-- the stream sees the full history. Quantity wasn't recorded then (NULL).
-- Existing packed Shopify orders are not backfilled: their sales channel
-- wasn't recorded, so they can't be confirmed as Trade Me-channel orders.
INSERT INTO "PackEvent" ("shop", "kind", "action", "purchaseId", "groupKey", "occurredAt")
SELECT "shop", 'trademe_purchase', 'packed', "purchaseId", "groupKey", "packedAt"
FROM "TradeMePackedItem"
ORDER BY "packedAt", "id";
