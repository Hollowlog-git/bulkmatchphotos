-- CreateTable
CREATE TABLE "DrawerRange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "drawerNumber" INTEGER NOT NULL,
    "startSku" TEXT,
    "endSku" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "DrawerRange_shop_drawerNumber_key" ON "DrawerRange"("shop", "drawerNumber");
