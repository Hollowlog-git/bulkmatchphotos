import type { ActionFunctionArgs, LoaderFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { isPickableSku } from "../lib/tradeMeItems";

// Pack Check's view of the Trade Me jobs pushed by the local app
// (see api.trademe-sync.tsx). Jobs are returned in the same shape as
// /api/orders so Pack Check can treat them like any other order. Their ids
// are prefixed "trademe:" so they are never sent to Shopify fulfilment.
//
// Items already marked packed here are left out, so a job vanishes from
// Pack Check as soon as it's packed, without waiting for the local app to
// process it and drop it from its next push.

const TRADEME_ID_PREFIX = "trademe:";


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [jobs, packed] = await Promise.all([
    db.tradeMeJob.findMany({ where: { shop }, include: { items: true } }),
    db.tradeMePackedItem.findMany({ where: { shop }, select: { purchaseId: true } }),
  ]);
  const packedIds = new Set(packed.map((p) => p.purchaseId));

  const orders = jobs
    .map((job) => {
      // Rows without a usable picking SKU (blank, or a "TV|..." integration
      // reference) aren't shown as pickable cards. The local app already
      // filters these; this is a backstop for older or unfiltered pushes.
      const items = job.items.filter(
        (i) => !i.packed && !packedIds.has(i.purchaseId) && isPickableSku(i.sku),
      );
      if (!items.length) return null;
      // Oldest sale in the job stands in for the order date; fall back to the
      // last sync time if the local app didn't send sold dates.
      const soldTimes = items
        .map((i) => (i.soldDate ? new Date(i.soldDate).getTime() : NaN))
        .filter((t) => !Number.isNaN(t));
      const createdAt = new Date(soldTimes.length ? Math.min(...soldTimes) : job.lastSyncedAt.getTime()).toISOString();
      const customer = job.buyerName || job.buyerUsername || `Trade Me buyer ${job.buyerMemberId ?? job.groupKey}`;
      const itemsShipping = items.reduce((s, i) => s + i.shippingPrice, 0);
      const shippingAmount = job.shippingPaid || itemsShipping;

      return {
        id: `${TRADEME_ID_PREFIX}${job.groupKey}`,
        name: `TM ${job.buyerUsername || job.groupKey}`,
        createdAt,
        note: job.readiness ? `Trade Me: ${job.readiness}` : null,
        status: "UNFULFILLED",
        financialStatus: "PAID",
        totalValue: job.paidTotal ?? job.totalSale + shippingAmount,
        customerId: null,
        customer,
        customerEmail: job.buyerEmail,
        customerTotalOrders: null,
        channel: "Trade Me",
        shippingTitle: "Trade Me shipping",
        shippingAmount,
        shippingOriginalAmount: shippingAmount,
        shippingWasFree: shippingAmount === 0,
        hasShippingDiscount: false,
        currencyCode: "NZD",
        discountCodes: [],
        shippingAddress: null,
        deliveryAddressText: job.deliveryAddress,
        fulfillmentOrders: [],
        tradeMe: {
          groupKey: job.groupKey,
          fulfilmentChannel: job.fulfilmentChannel,
          buyerUsername: job.buyerUsername,
          purchaseIds: items.map((i) => i.purchaseId),
        },
        lineItems: items.map((i) => ({
          id: `${TRADEME_ID_PREFIX}${i.purchaseId}`,
          title: i.title || `Listing ${i.listingId ?? i.purchaseId}`,
          quantity: i.quantity,
          sku: i.sku ?? "",
          variantTitle: undefined,
          imageUrl: i.imageUrl,
          productUrl: i.listingId ? `https://www.trademe.co.nz/a/listing/${i.listingId}` : null,
          productId: null,
          unitPrice: i.quantity ? i.salePrice / i.quantity : i.salePrice,
          originalUnitPrice: i.quantity ? i.salePrice / i.quantity : i.salePrice,
          currencyCode: "NZD",
        })),
      };
    })
    .filter(Boolean);

  return Response.json({ orders });
};

// Packing is recorded only through /api/pack-complete, which writes the
// package record and the events the local app reads. The first Trade Me
// version's POST/DELETE here bypassed both, so it's gone; an old open tab
// that still calls it gets a 410 and records nothing.
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  return Response.json(
    { error: "This packing endpoint was retired. Reload Pack Check and finish the package again." },
    { status: 410 },
  );
};
