import type { ActionFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Records a fully scanned package as packed. Nothing is fulfilled in
// Shopify. Shopify orders go into PackedOrder (hidden from Pack Check from
// then on); Trade Me purchases go into TradeMePackedItem. The local Trade Me
// app reads both back via GET /api/trademe-sync on its next sync.
//
// POST   { shopifyOrders: [{ id, name }], tradeMePurchases: [{ purchaseId, groupKey }] }
// DELETE { shopifyOrderIds: [...], purchaseIds: [...] }   — undo a mistaken pack
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    const body: any = await request.json();
    const strings = (v: any): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []);

    if (request.method === "DELETE") {
      const orderIds = strings(body?.shopifyOrderIds);
      const purchaseIds = strings(body?.purchaseIds);
      const [orders, items] = await db.$transaction([
        db.packedOrder.deleteMany({ where: { shop, orderId: { in: orderIds } } }),
        db.tradeMePackedItem.deleteMany({ where: { shop, purchaseId: { in: purchaseIds } } }),
      ]);
      return Response.json({ success: true, removedOrders: orders.count, removedItems: items.count });
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

    await db.$transaction([
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
    return Response.json({ success: true, orders: shopifyOrders.length, purchases: tradeMePurchases.length });
  } catch (error: any) {
    console.error("[pack-complete] failed:", error);
    return Response.json({ error: error.message ?? "Unknown error" }, { status: 500 });
  }
};
