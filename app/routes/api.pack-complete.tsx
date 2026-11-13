import type { ActionFunctionArgs, LoaderFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";
import crypto from "node:crypto";
import db from "../db.server";
import { channelFields, fetchLiveOrders, reportPendingShopifyOrders, type LiveOrder } from "../lib/shopifyOrderEvents.server";
import { writeUnpackedEvents } from "../lib/unpack.server";

async function purchaseIdsInPackages(shop: string): Promise<Set<string>> {
  const pkgs = await db.packedPackage.findMany({ where: { shop }, select: { purchaseIds: true } });
  return new Set(pkgs.flatMap((p) => JSON.parse(p.purchaseIds) as string[]));
}
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

  // Trade Me items packed without a package record (the first Trade Me
  // version's "Mark Trade Me job as packed" button), grouped by parcel, so
  // they can be seen and undone too.
  const since = new Date(Date.now() - PACKED_VIEW_DAYS * 86400000);
  const inPackages = await purchaseIdsInPackages(shop);
  const loose = (await db.tradeMePackedItem.findMany({ where: { shop, packedAt: { gt: since } }, orderBy: { packedAt: "desc" } }))
    .filter((r) => !inPackages.has(r.purchaseId));
  const byParcel = new Map<string, typeof loose>();
  for (const r of loose) byParcel.set(r.groupKey, [...(byParcel.get(r.groupKey) ?? []), r]);
  const jobs = await db.tradeMeJob.findMany({ where: { shop, groupKey: { in: [...byParcel.keys()] } } });
  const legacy = [...byParcel.entries()].map(([groupKey, rows]) => {
    const job = jobs.find((j) => j.groupKey === groupKey);
    return {
      groupKey,
      packedAt: rows[0].packedAt.toISOString(),
      purchaseIds: rows.map((r) => r.purchaseId),
      buyer: job ? job.buyerName || job.buyerUsername : null,
    };
  });

  return Response.json({
    days: PACKED_VIEW_DAYS,
    legacy,
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

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    const body: any = await request.json();

    if (request.method === "DELETE") {
      // Legacy: Trade Me items packed without a package record (the first
      // Trade Me version's "Mark Trade Me job as packed"), undone by parcel.
      if (typeof body?.legacyGroupKey === "string") {
        const groupKey = body.legacyGroupKey;
        const inPackages = await purchaseIdsInPackages(shop);
        const rows = (await db.tradeMePackedItem.findMany({ where: { shop, groupKey } })).filter((r) => !inPackages.has(r.purchaseId));
        if (!rows.length) return Response.json({ error: "Nothing packed to undo for that parcel" }, { status: 404 });
        const purchaseIds = rows.map((r) => r.purchaseId);
        const unpacked = await db.$transaction(async (tx) => {
          const n = await writeUnpackedEvents(tx, shop, { purchaseIds, orderIds: [], packageId: null });
          await tx.tradeMePackedItem.deleteMany({ where: { shop, purchaseId: { in: purchaseIds } } });
          return n;
        });
        console.log(`[pack-complete] undo legacy shop=${shop} groupKey=${groupKey} purchases=${purchaseIds.join(",")} unpackedEvents=${unpacked}`);
        return Response.json({ success: true, unpackedEvents: unpacked });
      }

      const pkg = typeof body?.packageId === "string"
        ? await db.packedPackage.findFirst({ where: { id: body.packageId, shop } })
        : null;
      if (!pkg) return Response.json({ error: "Packed package not found" }, { status: 404 });
      const orderIds = JSON.parse(pkg.shopifyOrderIds) as string[];
      const purchaseIds = JSON.parse(pkg.purchaseIds) as string[];
      // Tell the local app about the undo for every purchase and order in the
      // package that it was told was packed, however that event was tagged.
      const unpacked = await db.$transaction(async (tx) => {
        const n = await writeUnpackedEvents(tx, shop, { purchaseIds, orderIds, packageId: pkg.id });
        await tx.packedOrder.deleteMany({ where: { shop, orderId: { in: orderIds } } });
        await tx.tradeMePackedItem.deleteMany({ where: { shop, purchaseId: { in: purchaseIds } } });
        await tx.packedPackage.delete({ where: { id: pkg.id } });
        return n;
      });
      console.log(`[pack-complete] undo shop=${shop} package=${pkg.label} unpackedEvents=${unpacked}`);
      return Response.json({ success: true, unpackedEvents: unpacked });
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
    const live: Map<string, LiveOrder> = shopifyOrders.length
      ? await fetchLiveOrders(admin.graphql, shopifyOrders.map((o) => o.id))
      : new Map();
    const conflicts: Conflict[] = [
      ...checkTradeMePurchases(
        tradeMePurchases,
        snapshotRows.map((r) => ({ purchaseId: r.purchaseId, quantity: r.quantity, packed: r.packed, sku: r.sku, groupKey: r.job.groupKey })),
        new Set(packedItems.map((p) => p.purchaseId)),
      ),
      ...checkShopifyOrders(shopifyOrders, live as Map<string, any>, new Set(packedOrders.map((p) => p.orderId))),
    ];
    if (conflicts.length) {
      console.log(`[pack-complete] refused shop=${shop} conflicts=${JSON.stringify(conflicts)}`);
      return Response.json({ error: "This package changed since it was loaded", conflicts }, { status: 409 });
    }

    // ── Record ─────────────────────────────────────────────────────────
    const packageId = cuidLike();
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
      // Shopify orders start pending (reportState null); they're reported to
      // the local app just below, or on a later sync if that fails.
      ...shopifyOrders.map((o) =>
        db.packedOrder.create({ data: { shop, orderId: o.id, orderName: o.name, ...channelFields(live.get(o.id)) } }),
      ),
      ...tradeMePurchases.map((p) =>
        db.tradeMePackedItem.create({ data: { shop, purchaseId: p.purchaseId, groupKey: p.groupKey } }),
      ),
      ...tradeMePurchases.map((p) =>
        db.packEvent.create({
          data: { shop, kind: "trademe_purchase", action: "packed", packageId, purchaseId: p.purchaseId, groupKey: p.groupKey, quantity: p.quantity },
        }),
      ),
    ]);
    let report: any = null;
    if (shopifyOrders.length) {
      try {
        report = await reportPendingShopifyOrders(shop, admin.graphql, { only: shopifyOrders.map((o) => o.id), live });
      } catch (e: any) {
        // Not fatal: the orders stay pending and the next sync read reports them.
        console.error("[pack-complete] reporting Shopify orders deferred:", e?.message);
      }
    }
    console.log(
      `[pack-complete] shop=${shop} orders=${shopifyOrders.map((o) => o.name).join(",")} purchases=${purchaseIds.join(",")} shopifyReport=${JSON.stringify(report)}`,
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
