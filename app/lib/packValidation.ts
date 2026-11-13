import { isPickableSku } from "./tradeMeItems";

// Revalidates a package at the moment it's completed against the latest data,
// so a hold, refund, cancellation, fulfilment, quantity change or new item
// that arrived after the page loaded blocks completion instead of being
// recorded as packed. Pure functions: the caller loads the data.

// code lets callers group reasons; reason is the human-readable text.
export type ConflictCode =
  | "already_packed"      // Pack Check already recorded it as packed
  | "not_in_latest_sync"  // absent from the latest sync; central can't tell why
  | "moved_parcel"
  | "quantity_changed"
  | "new_item"
  | "not_found"
  | "cancelled"
  | "fulfilled"
  | "order_changed";
export interface Conflict { ref: string; code: ConflictCode; reason: string }

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
    // "Already packed" is checked first: once the local app processes a
    // packed tick, its next sync omits the purchase, and that must not read
    // as a problem with the sale.
    if (alreadyPacked.has(p.purchaseId) || item?.packed) {
      conflicts.push({ ref: p.purchaseId, code: "already_packed", reason: "already recorded as packed" });
    } else if (!item) {
      // Central only knows it's absent, not why. The local app owns the
      // reason (packed there, or no longer ready), so don't guess one.
      conflicts.push({ ref: p.purchaseId, code: "not_in_latest_sync", reason: "not in the latest Trade Me sync (it may already be packed in the local app, or is no longer ready to pack — check there)" });
    } else if (item.groupKey !== p.groupKey) {
      conflicts.push({ ref: p.purchaseId, code: "moved_parcel", reason: `moved to a different parcel (${item.groupKey})` });
    } else if (item.quantity !== p.quantity) {
      conflicts.push({ ref: p.purchaseId, code: "quantity_changed", reason: `quantity changed from ${p.quantity} to ${item.quantity}` });
    }
  }
  // Parcel identity: a pickable, unpacked item added to the parcel since the
  // page loaded means what was scanned is no longer the whole parcel.
  const submittedIds = new Set(submitted.map((p) => p.purchaseId));
  const groupKeys = new Set(submitted.map((p) => p.groupKey));
  for (const i of snapshotItems) {
    if (groupKeys.has(i.groupKey) && !submittedIds.has(i.purchaseId) && !i.packed && !alreadyPacked.has(i.purchaseId) && isPickableSku(i.sku)) {
      conflicts.push({ ref: i.purchaseId, code: "new_item", reason: `new item added to parcel ${i.groupKey} since this page loaded` });
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
    if (alreadyPacked.has(o.id)) { conflicts.push({ ref: o.name, code: "already_packed", reason: "already recorded as packed" }); continue; }
    if (!l) { conflicts.push({ ref: o.name, code: "not_found", reason: "not found in Shopify" }); continue; }
    if (l.cancelledAt) { conflicts.push({ ref: o.name, code: "cancelled", reason: "cancelled" }); continue; }
    if (l.displayFulfillmentStatus === "FULFILLED") { conflicts.push({ ref: o.name, code: "fulfilled", reason: "already fulfilled" }); continue; }
    const liveQty = new Map(l.lineItems.filter((li) => li.currentQuantity > 0).map((li) => [li.id, li.currentQuantity]));
    const sentQty = new Map(o.lineItems.map((li) => [li.id, li.quantity]));
    const same = liveQty.size === sentQty.size && [...liveQty].every(([id, q]) => sentQty.get(id) === q);
    if (!same) conflicts.push({ ref: o.name, code: "order_changed", reason: "items or quantities changed since this page loaded" });
  }
  return conflicts;
}
