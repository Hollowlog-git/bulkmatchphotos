-- AlterTable
ALTER TABLE "PackedOrder" ADD COLUMN "reportState" TEXT;

-- Orders that already have a "packed" shopify_order event were reported at
-- pack time; mark them so they're never reported twice. Everything else
-- stays NULL (pending) and is reported once the Trade Me channel is set.
UPDATE "PackedOrder" SET "reportState" = 'reported'
WHERE EXISTS (
  SELECT 1 FROM "PackEvent" e
  WHERE e."shop" = "PackedOrder"."shop" AND e."orderId" = "PackedOrder"."orderId"
    AND e."kind" = 'shopify_order' AND e."action" = 'packed'
);
