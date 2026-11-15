import crypto from "node:crypto";

// Local dispatch → central Pack Check, contract v1 (docs/trademe-sync.md).
// The local Trade Me app is authoritative for actual dispatch and its undo;
// Pack Check only records it, as "sent (local dispatch)", separately from
// physical scan history. Nothing here fulfils in Shopify, notifies anyone
// or buys labels, and nothing here is ever permission to send.

export const DISPATCH_CONTRACT_VERSION = 1;
export const MAX_DISPATCH_EVENTS = 500;

export interface DispatchEvent {
  eventId: string;
  groupKey: string;
  revision: number;
  status: "dispatched" | "dispatch_undone";
  purchaseIds: string[];
  shopifyOrderIds: string[];
  dispatchedAt: string | null;
  dispatchUndoneAt: string | null;
  observedAt: string;
  source: string;
  tracking: { purchaseId: string; reference: string; status: string }[];
}

const isoOrNull = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !Number.isNaN(Date.parse(v)) && /T/.test(v));
const shortStr = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9]\d*$/;

// Validates the whole batch; any problem rejects the whole request, so the
// snapshot is never half-applied.
export function validateDispatchEvents(raw: unknown): { events: DispatchEvent[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "dispatchEvents must be an array" };
  if (raw.length > MAX_DISPATCH_EVENTS) return { error: `At most ${MAX_DISPATCH_EVENTS} dispatchEvents per request` };
  const events: DispatchEvent[] = [];
  const seen = new Map<string, string>();
  for (const [i, e] of raw.entries()) {
    const at = `dispatchEvents[${i}]`;
    if (!e || typeof e !== "object") return { error: `${at} must be an object` };
    const x: any = e;
    if (!shortStr(x.eventId, 100)) return { error: `${at}.eventId is required` };
    if (!shortStr(x.groupKey, 200)) return { error: `${at}.groupKey is required` };
    if (!Number.isInteger(x.revision) || x.revision < 1) return { error: `${at}.revision must be a positive integer` };
    if (x.status !== "dispatched" && x.status !== "dispatch_undone") return { error: `${at}.status must be "dispatched" or "dispatch_undone"` };
    if (!Array.isArray(x.purchaseIds) || !x.purchaseIds.every((p: unknown) => shortStr(p, 50))) return { error: `${at}.purchaseIds must be an array of IDs` };
    const orders = x.shopifyOrderIds ?? [];
    if (!Array.isArray(orders) || !orders.every((o: unknown) => typeof o === "string" && ORDER_GID.test(o))) {
      return { error: `${at}.shopifyOrderIds must be Shopify order GIDs` };
    }
    if (!isoOrNull(x.dispatchedAt) || !isoOrNull(x.dispatchUndoneAt)) return { error: `${at}: dates must be ISO timestamps or null` };
    if (!(typeof x.observedAt === "string" && isoOrNull(x.observedAt))) return { error: `${at}.observedAt is required (ISO timestamp)` };
    if (!shortStr(x.source, 50)) return { error: `${at}.source is required` };
    const tracking = x.tracking ?? [];
    if (!Array.isArray(tracking) || !tracking.every((t: any) => t && shortStr(t.purchaseId, 50) && shortStr(t.reference, 100) && (t.status === undefined || t.status === null || shortStr(t.status, 50)))) {
      return { error: `${at}.tracking must be [{ purchaseId, reference, status }]` };
    }
    const ev: DispatchEvent = {
      eventId: x.eventId, groupKey: x.groupKey, revision: x.revision, status: x.status,
      purchaseIds: x.purchaseIds, shopifyOrderIds: orders,
      dispatchedAt: x.dispatchedAt ?? null, dispatchUndoneAt: x.dispatchUndoneAt ?? null,
      observedAt: x.observedAt, source: x.source,
      tracking: tracking.map((t: any) => ({ purchaseId: t.purchaseId, reference: t.reference, status: t.status ?? "" })),
    };
    const hash = contentHash(ev);
    const prev = seen.get(ev.eventId);
    if (prev && prev !== hash) return { error: `${at}: eventId ${ev.eventId} appears twice with different content` };
    if (!prev) { seen.set(ev.eventId, hash); events.push(ev); }
  }
  return { events };
}

// Content fingerprint: the same eventId must always carry the same content.
export function contentHash(e: DispatchEvent): string {
  const canonical = JSON.stringify({
    eventId: e.eventId, groupKey: e.groupKey, revision: e.revision, status: e.status,
    purchaseIds: [...e.purchaseIds].sort(), shopifyOrderIds: [...e.shopifyOrderIds].sort(),
    dispatchedAt: e.dispatchedAt, dispatchUndoneAt: e.dispatchUndoneAt, observedAt: e.observedAt, source: e.source,
    tracking: [...e.tracking].sort((a, b) => (a.purchaseId + a.reference).localeCompare(b.purchaseId + b.reference)),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// ── Sent state from the latest applied revision per local parcel ─────────
export interface DispatchStateLike {
  groupKey: string; revision: number; status: string;
  purchaseIds: string[]; shopifyOrderIds: string[];
  dispatchedAt: string | null; source: string;
  tracking: { purchaseId: string; reference: string; status: string }[];
}
export interface SentInfo { groupKey: string; dispatchedAt: string | null; tracking: string[]; source: string }

export function sentIndex(states: DispatchStateLike[]) {
  const purchases = new Map<string, SentInfo>();
  const orders = new Map<string, SentInfo>();
  for (const s of states) {
    if (s.status !== "dispatched") continue;
    const info = (pid?: string): SentInfo => ({
      groupKey: s.groupKey, dispatchedAt: s.dispatchedAt, source: s.source,
      tracking: s.tracking.filter((t) => !pid || t.purchaseId === pid).map((t) => t.reference),
    });
    for (const p of s.purchaseIds) purchases.set(p, info(p));
    for (const o of s.shopifyOrderIds) orders.set(o, info());
  }
  return { purchases, orders };
}

// A package is fully sent only when EVERY constituent purchase and order is
// sent (local dispatch, or Shopify fulfilment for an order). One sent source
// never marks its companions sent.
export function packageSentState(
  purchaseIds: string[], orderIds: string[],
  idx: ReturnType<typeof sentIndex>, shopifyFulfilled: Set<string>,
): { state: "sent" | "partial" | "unsent"; sent: number; total: number } {
  const total = purchaseIds.length + orderIds.length;
  const sent = purchaseIds.filter((p) => idx.purchases.has(p)).length
    + orderIds.filter((o) => idx.orders.has(o) || shopifyFulfilled.has(o)).length;
  return { state: total > 0 && sent === total ? "sent" : sent > 0 ? "partial" : "unsent", sent, total };
}
