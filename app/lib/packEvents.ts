// Packing acknowledgement stream for the local Trade Me app.
//
// Cursor: opaque to clients. Currently "v1.<last event id>"; clients must
// store and send it back unchanged, never build or compare it themselves.
//
// Trade Me channel: a Shopify order is reported to the local app only when
// the app that created it (Order.app, or its channel's app) has a GID listed
// in TRADEME_SHOPIFY_CHANNEL_APP_ID (comma-separated). The value is
// confirmed with the order diagnostic, never guessed from order names. While
// it's unset, no Shopify orders are reported, so website orders never show
// up locally as unmatched.

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

export function isTradeMeChannel(appIds: (string | null | undefined)[], configured = tradeMeChannelAppIds()): boolean {
  if (!configured.length) return false;
  return appIds.some((id) => !!id && configured.includes(id));
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
  lineItems: string | null;
  occurredAt: Date;
}

// The wire format. eventId is a string so clients treat it as opaque too.
export function serialiseEvent(e: PackEventRow) {
  const base = { eventId: String(e.id), type: e.action, kind: e.kind, packageId: e.packageId, occurredAt: e.occurredAt.toISOString() };
  if (e.kind === "trademe_purchase") {
    return { ...base, purchaseId: e.purchaseId, groupKey: e.groupKey, quantity: e.quantity };
  }
  return { ...base, orderId: e.orderId, orderName: e.orderName, lineItems: e.lineItems ? JSON.parse(e.lineItems) : [] };
}
