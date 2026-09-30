-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CustomerNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "customerId" TEXT,
    "customerEmail" TEXT,
    "customerName" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CustomerNote" ("customerEmail", "customerId", "customerName", "id", "note", "shop", "updatedAt") SELECT "customerEmail", "customerId", "customerName", "id", "note", "shop", "updatedAt" FROM "CustomerNote";
DROP TABLE "CustomerNote";
ALTER TABLE "new_CustomerNote" RENAME TO "CustomerNote";
CREATE INDEX "CustomerNote_shop_customerId_idx" ON "CustomerNote"("shop", "customerId");
CREATE INDEX "CustomerNote_shop_customerEmail_idx" ON "CustomerNote"("shop", "customerEmail");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
