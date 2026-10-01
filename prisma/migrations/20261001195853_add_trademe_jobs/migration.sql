-- CreateTable
CREATE TABLE "TradeMeJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "buyerUsername" TEXT,
    "buyerMemberId" TEXT,
    "buyerName" TEXT,
    "buyerEmail" TEXT,
    "deliveryAddress" TEXT,
    "fulfilmentChannel" TEXT NOT NULL,
    "readiness" TEXT,
    "kanbanCol" TEXT,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "totalSale" REAL NOT NULL DEFAULT 0,
    "shippingPaid" REAL NOT NULL DEFAULT 0,
    "paidTotal" REAL,
    "lastSyncedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TradeMeJobItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "listingId" TEXT,
    "sku" TEXT,
    "title" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "salePrice" REAL NOT NULL DEFAULT 0,
    "shippingPrice" REAL NOT NULL DEFAULT 0,
    "soldDate" TEXT,
    "saleChannel" TEXT,
    "packed" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "TradeMeJobItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "TradeMeJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TradeMeJob_shop_buyerEmail_idx" ON "TradeMeJob"("shop", "buyerEmail");

-- CreateIndex
CREATE UNIQUE INDEX "TradeMeJob_shop_groupKey_key" ON "TradeMeJob"("shop", "groupKey");

-- CreateIndex
CREATE UNIQUE INDEX "TradeMeJobItem_purchaseId_key" ON "TradeMeJobItem"("purchaseId");

-- CreateIndex
CREATE INDEX "TradeMeJobItem_jobId_idx" ON "TradeMeJobItem"("jobId");
