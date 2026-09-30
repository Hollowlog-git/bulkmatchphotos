-- CreateTable
CREATE TABLE "CustomerNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "customerId" TEXT,
    "customerEmail" TEXT,
    "customerName" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "CustomerNote_shop_customerId_idx" ON "CustomerNote"("shop", "customerId");

-- CreateIndex
CREATE INDEX "CustomerNote_shop_customerEmail_idx" ON "CustomerNote"("shop", "customerEmail");
