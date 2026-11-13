import type { ActionFunctionArgs, LoaderFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";
import crypto from "node:crypto";
import db from "../db.server";
import { hasTradeMeTag, isTradeMeChannel, tradeMeReferences } from "../lib/packEvents";
import {
  checkShopifyOrders, checkTradeMePurchases,
  type Conflict, type SubmittedOrder, type SubmittedPurchase,
} from "../lib/packValidation";

// Records a fully scanned package as packed. Nothing is fulfilled in
// Shopify. Shopify orders go into PackedOrder (hidden from Pack Check from
// then on); Trade Me purchases go into TradeMePackedItem. The local Trade Me
// app reads both back via GET /api/trademe-sync on its next sync. A copy of
// the package is kept in PackedPackage for Pack Check's "Packed" view.
//
// GET    -> { packages: [...] }  packed in the last PACKED_VIEW_DAYS days and
//           not yet sent (see loader)
// POST   { label, snapshot,
//          shopifyOrders: [{ id, name, lineItems: [{ id, quantity }] }],
//          tradeMePurchases: [{ purchaseId, groupKey, quantity }] }
//        -> 200 { packageId } | 409 { conflicts } if anything changed since
//           the page loaded (nothing is recorded) | 400 malformed
// DELETE { packageId }  — undo: the package goes back to "To pack"

const PACKED_VIEW_DAYS = 14;
const MAX_SNAPSHOT_ITEMS = 200;

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");
const httpsOrNull = (v: unknown) => (typeof v === "string" && /^https:\/\//i.test(v) && v.length <= 2048 ? v : null);

// Keep only the fields the Packed view shows, so the stored copy stays small
// and contains nothing unexpected.
function cleanSnapshot(raw: any) {
  const orders = Array.isArray(raw?.orders) ? raw.orders : [];
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return {
    customer: str(raw?.customer, 200),
    email: str(raw?.email, 320) || null,
    orders: orders.slice(0, 100).map((o: any) => ({ id: str(o?.id), name: str(o?.name, 100), channel: str(o?.channel, 100) })),
    items: items.slice(0, MAX_SNAPSHOT_ITEMS).map((i: any) => ({
      sku: str(i?.sku, 100),
      title: str(i?.title, 300),
      quantity: Number.isFinite(i?.quantity) ? Math.max(0, Math.floor(i.quantity)) : 0,
      imageUrl: httpsOrNull(i?.imageUrl),
    })),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const packages = await db.packedPackage.findMany({
    where: { shop, packedAt: { gt: new Date(Date.now() - PACKED_VIEW_DAYS * 86400000) } },
    orderBy: { packedAt: "desc" },
  });

  // Ask Shopify which of these orders have since been fulfilled (= sent).
  const allIds = [...new Set(packages.flatMap((p) => JSON.parse(p.shopifyOrderIds) as string[]))];
  const fulfilled = new Set<string>();
  for (let i = 0; i < allIds.length; i += 100) {
    const res = await admin.graphql(
      `#graphql
      query PackedOrderStatus($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            id
            displayFulfillmentStatus
          }
        }
      }`,
      { variables: { ids: allIds.slice(i, i + 100) } },
    );
    const data: any = await res.json();
    for (const n of data?.data?.nodes ?? []) {
      if (n?.id && n.displayFulfillmentStatus === "FULFILLED") fulfilled.add(n.id);
    }
  }

  return Response.json({
    days: PACKED_VIEW_DAYS,
    packages: packages
      .map((p) => {
        const orderIds = JSON.parse(p.shopifyOrderIds) as string[];
        const purchaseIds = JSON.parse(p.purchaseIds) as string[];
        const snapshot = JSON.parse(p.snapshot);
        return {
          id: p.id,
          label: p.label,
          packedAt: p.packedAt.toISOString(),
          tradeMeItems: purchaseIds.length,
          ...snapshot,
          orders: (snapshot.orders ?? []).map((o: any) => ({ ...o, sent: fulfilled.has(o.id) })),
          // A package with Shopify orders counts as sent once all of them are
          // fulfilled. Trade Me-only packages can't be checked from here
          // (dispatch is tracked in the local app), so they stay listed.
          sent: orderIds.length > 0 && orderIds.every((id) => fulfilled.has(id)),
        };
      })
      .filter((p) => !p.sent),
  });
};

const LIVE_ORDERS_QUERY = `#graphql
  query PackCompleteOrders($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        name
        cancelledAt
        displayFulfillmentStatus
        tags
        customAttributes { key value }
        app { id name }
        channelInformation {
          app { id title }
          channelDefinition { handle channelName }
        }
        lineItems(first: 100) {
          pageInfo { hasNextPage }
          nodes { id sku quantity currentQuantity }
        }
      }
    }
  }`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    const body: any = await request.json();

    if (request.method === "DELETE") {
      const pkg = typeof body?.packageId === "string"
        ? await db.packedPackage.findFirst({ where: { id: body.packageId, shop } })
        : null;
      if (!pkg) return Response.json({ error: "Packed package not found" }, { status: 404 });
      const orderIds = JSON.parse(pkg.shopifyOrderIds) as string[];
      const purchaseIds = JSON.parse(pkg.purchaseIds) as string[];
      // Tell the local app about the undo for everything it was told was packed.
      const told = await db.packEvent.findMany({ where: { shop, packageId: pkg.id, action: "packed" } });
      await db.$transaction([
        ...told.map((e) => db.packEvent.create({
          data: { shop, kind: e.kind, action: "unpacked", packageId: pkg.id, purchaseId: e.purchaseId, groupKey: e.groupKey,
            quantity: e.quantity, orderId: e.orderId, orderName: e.orderName, salesRecordId: e.salesRecordId, lineItems: e.lineItems },
        })),
        db.packedOrder.deleteMany({ where: { shop, orderId: { in: orderIds } } }),
        db.tradeMePackedItem.deleteMany({ where: { shop, purchaseId: { in: purchaseIds } } }),
        db.packedPackage.delete({ where: { id: pkg.id } }),
      ]);
      console.log(`[pack-complete] undo shop=${shop} package=${pkg.label}`);
      return Response.json({ success: true });
    }

    if (request.method !== "POST") {
      return Response.json({ error: "POST or DELETE only" }, { status: 405 });
    }

    const isStr = (v: any) => typeof v === "string" && v.trim().length > 0;
    const isQty = (v: any) => Number.isInteger(v) && v > 0;
    const shopifyOrders: SubmittedOrder[] = Array.isArray(body?.shopifyOrders)
      ? body.shopifyOrders.filter((o: any) => isStr(o?.id) && typeof o?.name === "string" && Array.isArray(o?.lineItems)
          && o.lineItems.every((li: any) => isStr(li?.id) && isQty(li?.quantity)))
      : [];
    const tradeMePurchases: SubmittedPurchase[] = Array.isArray(body?.tradeMePurchases)
      ? body.tradeMePurchases.filter((p: any) => isStr(p?.purchaseId) && isStr(p?.groupKey) && isQty(p?.quantity))
      : [];
    const sentOrders = Array.isArray(body?.shopifyOrders) ? body.shopifyOrders.length : 0;
    const sentPurchases = Array.isArray(body?.tradeMePurchases) ? body.tradeMePurchases.length : 0;
    if (shopifyOrders.length !== sentOrders || tradeMePurchases.length !== sentPurchases) {
      return Response.json({ error: "Malformed package: every order needs id, name and line items with quantities; every Trade Me purchase needs purchaseId, groupKey and quantity" }, { status: 400 });
    }
    if (!shopifyOrders.length && !tradeMePurchases.length) {
      return Response.json({ error: "Nothing to record" }, { status: 400 });
    }

    // ── Revalidate against the latest data ──────────────────────────────
    const groupKeys = [...new Set(tradeMePurchases.map((p) => p.groupKey))];
    const purchaseIds = tradeMePurchases.map((p) => p.purchaseId);
    const [snapshotRows, packedItems, packedOrders] = await Promise.all([
      db.tradeMeJobItem.findMany({
        where: { job: { shop }, OR: [{ job: { groupKey: { in: groupKeys } } }, { purchaseId: { in: purchaseIds } }] },
        include: { job: { select: { groupKey: true } } },
      }),
      db.tradeMePackedItem.findMany({ where: { shop }, select: { purchaseId: true } }),
      db.packedOrder.findMany({ where: { shop, orderId: { in: shopifyOrders.map((o) => o.id) } }, select: { orderId: true } }),
    ]);
    const live = new Map<string, any>();
    if (shopifyOrders.length) {
      const res = await admin.graphql(LIVE_ORDERS_QUERY, { variables: { ids: shopifyOrders.map((o) => o.id) } });
      const data: any = await res.json();
      if (data?.errors) throw new Error("Shopify order check failed");
      for (const n of data?.data?.nodes ?? []) {
        if (n?.id) live.set(n.id, { ...n, lineItems: n.lineItems?.nodes ?? [], lineItemsComplete: !n.lineItems?.pageInfo?.hasNextPage });
      }
    }
    const conflicts: Conflict[] = [
      ...checkTradeMePurchases(
        tradeMePurchases,
        snapshotRows.map((r) => ({ purchaseId: r.purchaseId, quantity: r.quantity, packed: r.packed, sku: r.sku, groupKey: r.job.groupKey })),
        new Set(packedItems.map((p) => p.purchaseId)),
      ),
      ...checkShopifyOrders(shopifyOrders, live, new Set(packedOrders.map((p) => p.orderId))),
    ];
    if (conflicts.length) {
      console.log(`[pack-complete] refused shop=${shop} conflicts=${JSON.stringify(conflicts)}`);
      return Response.json({ error: "This package changed since it was loaded", conflicts }, { status: 409 });
    }

    // ── Record ─────────────────────────────────────────────────────────
    const packageId = cuidLike();
    const channelOf = (o: any) => ({
      channelAppId: o?.app?.id ?? o?.channelInformation?.app?.id ?? null,
      channelHandle: o?.channelInformation?.channelDefinition?.handle ?? null,
      channelName: o?.channelInformation?.channelDefinition?.channelName ?? null,
      hasTradeMeTag: hasTradeMeTag(o?.tags),
    });
    const shopifyEvents = shopifyOrders
      .map((o) => ({ o, l: live.get(o.id) }))
      .filter(({ l }) => isTradeMeChannel([l?.app?.id, l?.channelInformation?.app?.id], l?.tags))
      .map(({ o, l }) => ({
        o,
        l,
        refs: tradeMeReferences({ customAttributes: l.customAttributes, lineItemCount: l.lineItems.length, lineItemsComplete: l.lineItemsComplete }),
      }));

    await db.$transaction([
      db.packedPackage.create({
        data: {
          id: packageId,
          shop,
          label: str(body?.label, 200) || shopifyOrders.map((o) => o.name).join(", ") || "Trade Me package",
          shopifyOrderIds: JSON.stringify(shopifyOrders.map((o) => o.id)),
          purchaseIds: JSON.stringify(purchaseIds),
          snapshot: JSON.stringify(cleanSnapshot(body?.snapshot)),
        },
      }),
      ...shopifyOrders.map((o) =>
        db.packedOrder.create({ data: { shop, orderId: o.id, orderName: o.name, ...channelOf(live.get(o.id)) } }),
      ),
      ...tradeMePurchases.map((p) =>
        db.tradeMePackedItem.create({ data: { shop, purchaseId: p.purchaseId, groupKey: p.groupKey } }),
      ),
      ...tradeMePurchases.map((p) =>
        db.packEvent.create({
          data: { shop, kind: "trademe_purchase", action: "packed", packageId, purchaseId: p.purchaseId, groupKey: p.groupKey, quantity: p.quantity },
        }),
      ),
      ...shopifyEvents.map(({ o, l, refs }) =>
        db.packEvent.create({
          data: {
            shop, kind: "shopify_order", action: "packed", packageId, orderId: o.id, orderName: o.name,
            salesRecordId: refs.salesRecordId,
            // The purchase ID is only set for an unambiguous single-purchase
            // order (lib/packEvents.ts tradeMeReferences); otherwise null.
            lineItems: JSON.stringify(
              (l.lineItems as any[]).filter((li) => li.currentQuantity > 0)
                .map((li) => ({ lineItemId: li.id, sku: li.sku ?? null, quantity: li.currentQuantity, tradeMePurchaseId: refs.purchaseId })),
            ),
          },
        }),
      ),
    ]);
    console.log(
      `[pack-complete] shop=${shop} orders=${shopifyOrders.map((o) => o.name).join(",")} purchases=${purchaseIds.join(",")} shopifyEvents=${shopifyEvents.length}`,
    );
    return Response.json({ success: true, packageId });
  } catch (error: any) {
    console.error("[pack-complete] failed:", error);
    return Response.json({ error: error.message ?? "Unknown error" }, { status: 500 });
  }
};

function cuidLike() {
  return `pkg_${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
