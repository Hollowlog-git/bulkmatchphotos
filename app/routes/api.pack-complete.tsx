import type { ActionFunctionArgs, LoaderFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Records a fully scanned package as packed. Nothing is fulfilled in
// Shopify. Shopify orders go into PackedOrder (hidden from Pack Check from
// then on); Trade Me purchases go into TradeMePackedItem. The local Trade Me
// app reads both back via GET /api/trademe-sync on its next sync. A copy of
// the package is kept in PackedPackage for Pack Check's "Packed" view.
//
// GET    -> { packages: [...] }  packed in the last PACKED_VIEW_DAYS days and
//           not yet sent (see loader)
// POST   { label, snapshot, shopifyOrders: [{ id, name }], tradeMePurchases: [{ purchaseId, groupKey }] }
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

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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
      await db.$transaction([
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

    const shopifyOrders: { id: string; name: string }[] = Array.isArray(body?.shopifyOrders)
      ? body.shopifyOrders.filter((o: any) => typeof o?.id === "string" && o.id.trim() && typeof o?.name === "string")
      : [];
    const tradeMePurchases: { purchaseId: string; groupKey: string }[] = Array.isArray(body?.tradeMePurchases)
      ? body.tradeMePurchases.filter((p: any) => typeof p?.purchaseId === "string" && p.purchaseId.trim() && typeof p?.groupKey === "string")
      : [];
    if (!shopifyOrders.length && !tradeMePurchases.length) {
      return Response.json({ error: "Nothing to record" }, { status: 400 });
    }

    const [pkg] = await db.$transaction([
      db.packedPackage.create({
        data: {
          shop,
          label: str(body?.label, 200) || shopifyOrders.map((o) => o.name).join(", ") || "Trade Me package",
          shopifyOrderIds: JSON.stringify(shopifyOrders.map((o) => o.id)),
          purchaseIds: JSON.stringify(tradeMePurchases.map((p) => p.purchaseId)),
          snapshot: JSON.stringify(cleanSnapshot(body?.snapshot)),
        },
      }),
      ...shopifyOrders.map((o) =>
        db.packedOrder.upsert({
          where: { shop_orderId: { shop, orderId: o.id } },
          create: { shop, orderId: o.id, orderName: o.name },
          update: {},
        }),
      ),
      ...tradeMePurchases.map((p) =>
        db.tradeMePackedItem.upsert({
          where: { shop_purchaseId: { shop, purchaseId: p.purchaseId } },
          create: { shop, purchaseId: p.purchaseId, groupKey: p.groupKey },
          update: {},
        }),
      ),
    ]);
    console.log(
      `[pack-complete] shop=${shop} orders=${shopifyOrders.map((o) => o.name).join(",")} purchases=${tradeMePurchases.map((p) => p.purchaseId).join(",")}`,
    );
    return Response.json({ success: true, packageId: pkg.id });
  } catch (error: any) {
    console.error("[pack-complete] failed:", error);
    return Response.json({ error: error.message ?? "Unknown error" }, { status: 500 });
  }
};
