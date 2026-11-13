import { isPickableSku } from "./tradeMeItems";

// Revalidates a package at the moment it's completed against the latest data,
// so a hold, refund, cancellation, fulfilment, quantity change or new item
// that arrived after the page loaded blocks completion instead of being
// recorded as packed. Pure functions: the caller loads the data.

export interface Conflict { ref: string; reason: string }

// --- Trade Me purchases vs the latest synced snapshot -----------------------
export interface SubmittedPurchase { purchaseId: string; groupKey: string; quantity: number }
export interface SnapshotItem { purchaseId: string; quantity: number; packed: boolean; sku: string | null; groupKey: string }

export function checkTradeMePurchases(
  submitted: SubmittedPurchase[],
  snapshotItems: SnapshotItem[], // every current item of the submitted groupKeys, plus the submitted purchase IDs wherever they now are
  alreadyPacked: Set<string>,
): Conflict[] {
  const conflicts: Conflict[] = [];
  const byPurchase = new Map(snapshotItems.map((i) => [i.purchaseId, i]));
  for (const p of submitted) {
    const item = byPurchase.get(p.purchaseId);
    if (!item) conflicts.push({ ref: p.purchaseId, reason: "no longer ready to pack (removed from the latest Trade Me sync — held, refunded, cancelled or dispatched?)" });
    else if (item.groupKey !== p.groupKey) conflicts.push({ ref: p.purchaseId, reason: `moved to a different parcel (${item.groupKey})` });
    else if (item.quantity !== p.quantity) conflicts.push({ ref: p.purchaseId, reason: `quantity changed from ${p.quantity} to ${item.quantity}` });
    else if (item.packed || alreadyPacked.has(p.purchaseId)) conflicts.push({ ref: p.purchaseId, reason: "already recorded as packed" });
  }
  // Parcel identity: a pickable, unpacked item added to the parcel since the
  // page loaded means what was scanned is no longer the whole parcel.
  const submittedIds = new Set(submitted.map((p) => p.purchaseId));
  const groupKeys = new Set(submitted.map((p) => p.groupKey));
  for (const i of snapshotItems) {
    if (groupKeys.has(i.groupKey) && !submittedIds.has(i.purchaseId) && !i.packed && !alreadyPacked.has(i.purchaseId) && isPickableSku(i.sku)) {
      conflicts.push({ ref: i.purchaseId, reason: `new item added to parcel ${i.groupKey} since this page loaded` });
    }
  }
  return conflicts;
}

// --- Shopify orders vs Shopify right now -------------------------------------
export interface SubmittedOrder { id: string; name: string; lineItems: { id: string; quantity: number }[] }
export interface LiveOrder {
  id: string;
  cancelledAt: string | null;
  displayFulfillmentStatus: string;
  lineItems: { id: string; sku: string | null; currentQuantity: number }[];
}

export function checkShopifyOrders(submitted: SubmittedOrder[], live: Map<string, LiveOrder>, alreadyPacked: Set<string>): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const o of submitted) {
    const l = live.get(o.id);
    if (!l) { conflicts.push({ ref: o.name, reason: "not found in Shopify" }); continue; }
    if (l.cancelledAt) { conflicts.push({ ref: o.name, reason: "cancelled" }); continue; }
    if (l.displayFulfillmentStatus === "FULFILLED") { conflicts.push({ ref: o.name, reason: "already fulfilled" }); continue; }
    if (alreadyPacked.has(o.id)) { conflicts.push({ ref: o.name, reason: "already recorded as packed" }); continue; }
    const liveQty = new Map(l.lineItems.filter((li) => li.currentQuantity > 0).map((li) => [li.id, li.currentQuantity]));
    const sentQty = new Map(o.lineItems.map((li) => [li.id, li.quantity]));
    const same = liveQty.size === sentQty.size && [...liveQty].every(([id, q]) => sentQty.get(id) === q);
    if (!same) conflicts.push({ ref: o.name, reason: "items or quantities changed since this page loaded" });
  }
  return conflicts;
}
