-- CreateTable
CREATE TABLE "TradeMeBuyer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "name" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "TradeMeBuyer_shop_email_key" ON "TradeMeBuyer"("shop", "email");

-- Seed from the Trade Me jobs already synced.
INSERT OR IGNORE INTO "TradeMeBuyer" ("id", "shop", "email", "username", "name", "updatedAt")
SELECT 'tmb_' || lower(hex(randomblob(10))), "shop", lower(trim("buyerEmail")), "buyerUsername", "buyerName", CURRENT_TIMESTAMP
FROM "TradeMeJob"
WHERE "buyerEmail" IS NOT NULL AND trim("buyerEmail") <> '' AND "buyerUsername" IS NOT NULL AND trim("buyerUsername") <> '';
