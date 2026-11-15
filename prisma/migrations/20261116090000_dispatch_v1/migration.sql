-- CreateTable
CREATE TABLE "DispatchReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "purchaseIds" TEXT NOT NULL,
    "shopifyOrderIds" TEXT NOT NULL,
    "dispatchedAt" DATETIME,
    "dispatchUndoneAt" DATETIME,
    "observedAt" DATETIME NOT NULL,
    "source" TEXT NOT NULL,
    "tracking" TEXT NOT NULL,
    "applied" BOOLEAN NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DispatchState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "purchaseIds" TEXT NOT NULL,
    "shopifyOrderIds" TEXT NOT NULL,
    "dispatchedAt" DATETIME,
    "source" TEXT NOT NULL,
    "tracking" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "DispatchReceipt_shop_eventId_key" ON "DispatchReceipt"("shop", "eventId");

-- CreateIndex
CREATE INDEX "DispatchReceipt_shop_groupKey_idx" ON "DispatchReceipt"("shop", "groupKey");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchState_shop_groupKey_key" ON "DispatchState"("shop", "groupKey");
