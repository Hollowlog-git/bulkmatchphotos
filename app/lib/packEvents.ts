// Packing acknowledgement stream for the local Trade Me app.
//
// Cursor: opaque to clients. Currently "v1.<last event id>"; clients must
// store and send it back unchanged, never build or compare it themselves.
//
// Trade Me channel: a Shopify order is reported to the local app only when
// BOTH hold:
//   - the app that created it (Order.app, or its channel's app) has a GID
//     listed in TRADEME_SHOPIFY_CHANNEL_APP_ID (comma-separated). Confirmed
//     with the order diagnostic: Omnivore, gid://shopify/App/1203668; and
//   - it carries the "trademe" tag, because it isn't established that
//     Omnivore only handles Trade Me.
// Never guessed from order names. While the setting is unset, no Shopify
// orders are reported, so website orders never show up locally as unmatched.

export function encodeCursor(id: number): string {
  return `v1.${id}`;
}

// Returns the last delivered event id, 0 for "from the start", or null for
// a malformed cursor.
export function decodeCursor(raw: string | null): number | null {
  if (raw === null || raw === "") return 0;
  const m = /^v1\.(\d{1,15})$/.exec(raw);
  return m ? Number(m[1]) : null;
}

export function tradeMeChannelAppIds(env = process.env.TRADEME_SHOPIFY_CHANNEL_APP_ID): string[] {
  return (env ?? "").split(",").map((s) => s.trim()).filter((s) => /^gid:\/\/shopify\/App\/\d+$/.test(s));
}

export const TRADEME_TAG = "trademe";

export function hasTradeMeTag(tags: string[] | null | undefined): boolean {
  return (tags ?? []).some((t) => t.trim().toLowerCase() === TRADEME_TAG);
}

export function isTradeMeChannel(
  appIds: (string | null | undefined)[],
  tags: string[] | null | undefined,
  configured = tradeMeChannelAppIds(),
): boolean {
  if (!configured.length || !hasTradeMeTag(tags)) return false;
  return appIds.some((id) => !!id && configured.includes(id));
}

// Trade Me references on an Omnivore order. Omnivore stores them as
// order-level custom attributes; lines carry none.
//   "Trade Me sales record ID": "P<purchaseId>", e.g. P252876776. Confirmed
//   against 4,547 local purchases: every populated one is "P" + purchase ID.
// The raw sales record ID is always passed through. A purchase ID is derived
// only for an unambiguous single-purchase order: the order has exactly one
// line in total (lines removed or refunded to zero still count, so an order
// that originally had several lines stays ambiguous) and the record ID has
// the confirmed format. Anything else gives null.
export const SALES_RECORD_KEY = "Trade Me sales record ID";

export function tradeMeReferences(order: {
  customAttributes?: { key: string; value: string | null }[] | null;
  lineItemCount: number; // every line on the order, whatever its current quantity
  lineItemsComplete: boolean; // false if Shopify had more lines than were fetched
}): { salesRecordId: string | null; purchaseId: string | null } {
  const raw = (order.customAttributes ?? []).find((a) => a.key === SALES_RECORD_KEY)?.value ?? null;
  const salesRecordId = raw && raw.trim() ? raw.trim() : null;
  const m = salesRecordId ? /^P(\d{1,20})$/.exec(salesRecordId) : null;
  const single = order.lineItemsComplete && order.lineItemCount === 1;
  return { salesRecordId, purchaseId: m && single ? m[1] : null };
}

export interface PackEventRow {
  id: number;
  kind: string;
  action: string;
  packageId: string | null;
  purchaseId: string | null;
  groupKey: string | null;
  quantity: number | null;
  orderId: string | null;
  orderName: string | null;
  salesRecordId?: string | null;
  lineItems: string | null;
  occurredAt: Date;
}

// The wire format. eventId is a string so clients treat it as opaque too.
export function serialiseEvent(e: PackEventRow) {
  const base = { eventId: String(e.id), type: e.action, kind: e.kind, packageId: e.packageId, occurredAt: e.occurredAt.toISOString() };
  if (e.kind === "trademe_purchase") {
    return { ...base, purchaseId: e.purchaseId, groupKey: e.groupKey, quantity: e.quantity };
  }
  return {
    ...base,
    orderId: e.orderId,
    orderName: e.orderName,
    tradeMeSalesRecordId: e.salesRecordId ?? null,
    lineItems: e.lineItems ? JSON.parse(e.lineItems) : [],
  };
}
