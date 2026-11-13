import db from "../db.server";
import { hasTradeMeTag, isTradeMeChannel, tradeMeChannelAppIds, tradeMeReferences } from "./packEvents";

// Reports packed Shopify orders to the local Trade Me app as "shopify_order"
// PackEvents. Every PackedOrder starts with reportState = null ("pending").
// Once the Trade Me channel is configured, each pending order is looked up in
// Shopify and either:
//   - reported: a "packed" event with its lines and Trade Me references, or
//   - marked "not_trademe" (website or other non-Trade Me order: no event), or
//   - marked "missing" (Shopify no longer has it).
// Orders packed before the channel was configured therefore aren't missed:
// they stay pending and are reported the first time this runs afterwards.
// Runs at pack time and at the start of every local sync read. Safe to rerun:
// each order is reported at most once per pack (undo deletes the PackedOrder
// and appends "unpacked"; packing again creates a new pending row).

type Graphql = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

export const LIVE_ORDERS_QUERY = `#graphql
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

export interface LiveOrder {
  id: string;
  name: string;
  cancelledAt: string | null;
  displayFulfillmentStatus: string;
  tags: string[];
  customAttributes: { key: string; value: string | null }[];
  app: { id: string } | null;
  channelInformation: any;
  lineItems: { id: string; sku: string | null; quantity: number; currentQuantity: number }[];
  lineItemsComplete: boolean;
}

export async function fetchLiveOrders(graphql: Graphql, ids: string[]): Promise<Map<string, LiveOrder>> {
  const live = new Map<string, LiveOrder>();
  for (let i = 0; i < ids.length; i += 100) {
    const res = await graphql(LIVE_ORDERS_QUERY, { variables: { ids: ids.slice(i, i + 100) } });
    const data: any = await res.json();
    if (data?.errors) throw new Error("Shopify order lookup failed");
    for (const n of data?.data?.nodes ?? []) {
      if (n?.id) live.set(n.id, { ...n, lineItems: n.lineItems?.nodes ?? [], lineItemsComplete: !n.lineItems?.pageInfo?.hasNextPage });
    }
  }
  return live;
}

export function channelFields(o: LiveOrder | undefined) {
  return {
    channelAppId: o?.app?.id ?? o?.channelInformation?.app?.id ?? null,
    channelHandle: o?.channelInformation?.channelDefinition?.handle ?? null,
    channelName: o?.channelInformation?.channelDefinition?.channelName ?? null,
    hasTradeMeTag: o ? hasTradeMeTag(o.tags) : null,
  };
}

const BATCH = 250;

export async function reportPendingShopifyOrders(
  shop: string,
  graphql: Graphql,
  opts: { only?: string[]; live?: Map<string, LiveOrder> } = {},
): Promise<{ configured: boolean; reported: number; notTradeMe: number; missing: number; stillPending: number }> {
  const configured = tradeMeChannelAppIds();
  const result = { configured: configured.length > 0, reported: 0, notTradeMe: 0, missing: 0, stillPending: 0 };
  if (!configured.length) {
    result.stillPending = await db.packedOrder.count({ where: { shop, reportState: null } });
    return result;
  }

  const pending = await db.packedOrder.findMany({
    where: { shop, reportState: null, ...(opts.only ? { orderId: { in: opts.only } } : {}) },
    orderBy: { packedAt: "asc" },
    take: BATCH,
  });
  if (pending.length) {
    const missingIds = pending.map((p) => p.orderId).filter((id) => !opts.live?.has(id));
    const live = new Map([...(opts.live ?? []), ...(missingIds.length ? await fetchLiveOrders(graphql, missingIds) : [])]);

    for (const p of pending) {
      const l = live.get(p.orderId);
      if (!l) {
        await db.packedOrder.updateMany({ where: { id: p.id, reportState: null }, data: { reportState: "missing" } });
        result.missing++;
        continue;
      }
      if (!isTradeMeChannel([l.app?.id, l.channelInformation?.app?.id], l.tags, configured)) {
        await db.packedOrder.updateMany({ where: { id: p.id, reportState: null }, data: { reportState: "not_trademe", ...channelFields(l) } });
        result.notTradeMe++;
        continue;
      }
      const refs = tradeMeReferences({ customAttributes: l.customAttributes, lineItemCount: l.lineItems.length, lineItemsComplete: l.lineItemsComplete });
      const pkg = await db.packedPackage.findFirst({
        where: { shop, shopifyOrderIds: { contains: JSON.stringify(p.orderId) } },
        orderBy: { packedAt: "desc" },
        select: { id: true },
      });
      // Claim the row and write the event together, so a rerun or a
      // concurrent run can't report the same pack twice.
      await db.$transaction(async (tx) => {
        const claimed = await tx.packedOrder.updateMany({
          where: { id: p.id, reportState: null },
          data: { reportState: "reported", ...channelFields(l) },
        });
        if (claimed.count !== 1) return;
        await tx.packEvent.create({
          data: {
            shop, kind: "shopify_order", action: "packed", packageId: pkg?.id ?? null,
            orderId: p.orderId, orderName: p.orderName, salesRecordId: refs.salesRecordId,
            occurredAt: p.packedAt, // when it was actually packed
            lineItems: JSON.stringify(
              l.lineItems.filter((li) => li.currentQuantity > 0)
                .map((li) => ({ lineItemId: li.id, sku: li.sku ?? null, quantity: li.currentQuantity, tradeMePurchaseId: refs.purchaseId })),
            ),
          },
        });
        result.reported++;
      });
    }
  }
  result.stillPending = await db.packedOrder.count({ where: { shop, reportState: null } });
  return result;
}
