import db from "../db.server";
import { contentHash, sentIndex, type DispatchEvent } from "./dispatch";

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

// Before any mutation: event IDs already stored with DIFFERENT content are
// conflicts (the whole request is refused, nothing changes).
export async function findDispatchConflicts(shop: string, events: DispatchEvent[]): Promise<string[]> {
  if (!events.length) return [];
  const existing = await db.dispatchReceipt.findMany({
    where: { shop, eventId: { in: events.map((e) => e.eventId) } },
    select: { eventId: true, contentHash: true },
  });
  const byId = new Map(existing.map((r) => [r.eventId, r.contentHash]));
  return events.filter((e) => byId.has(e.eventId) && byId.get(e.eventId) !== contentHash(e)).map((e) => e.eventId);
}

// Inside the sync transaction: store each new receipt immutably, and apply it
// to its group only if its revision is newer than the one applied. Duplicate
// receipts are no-ops. Returns every event ID now durably held (to ack).
export async function storeDispatchEvents(tx: Tx, shop: string, events: DispatchEvent[]): Promise<string[]> {
  const acked: string[] = [];
  for (const e of events) {
    const existing = await tx.dispatchReceipt.findUnique({ where: { shop_eventId: { shop, eventId: e.eventId } } });
    if (existing) { acked.push(e.eventId); continue; } // duplicate delivery: no-op
    const state = await tx.dispatchState.findUnique({ where: { shop_groupKey: { shop, groupKey: e.groupKey } } });
    const newer = !state || e.revision > state.revision;
    await tx.dispatchReceipt.create({
      data: {
        shop, eventId: e.eventId, contentHash: contentHash(e), groupKey: e.groupKey, revision: e.revision, status: e.status,
        purchaseIds: JSON.stringify(e.purchaseIds), shopifyOrderIds: JSON.stringify(e.shopifyOrderIds),
        dispatchedAt: e.dispatchedAt ? new Date(e.dispatchedAt) : null,
        dispatchUndoneAt: e.dispatchUndoneAt ? new Date(e.dispatchUndoneAt) : null,
        observedAt: new Date(e.observedAt), source: e.source, tracking: JSON.stringify(e.tracking), applied: newer,
      },
    });
    if (newer) {
      const data = {
        revision: e.revision, eventId: e.eventId, status: e.status,
        purchaseIds: JSON.stringify(e.purchaseIds), shopifyOrderIds: JSON.stringify(e.shopifyOrderIds),
        dispatchedAt: e.dispatchedAt ? new Date(e.dispatchedAt) : null, source: e.source, tracking: JSON.stringify(e.tracking),
      };
      await tx.dispatchState.upsert({
        where: { shop_groupKey: { shop, groupKey: e.groupKey } },
        create: { shop, groupKey: e.groupKey, ...data },
        update: data,
      });
    }
    acked.push(e.eventId);
  }
  return acked;
}

export async function loadSentIndex(shop: string) {
  const states = await db.dispatchState.findMany({ where: { shop } });
  const parsed = states.map((s) => ({
    groupKey: s.groupKey, revision: s.revision, status: s.status,
    purchaseIds: JSON.parse(s.purchaseIds) as string[], shopifyOrderIds: JSON.parse(s.shopifyOrderIds) as string[],
    dispatchedAt: s.dispatchedAt ? s.dispatchedAt.toISOString() : null, source: s.source,
    tracking: JSON.parse(s.tracking) as { purchaseId: string; reference: string; status: string }[],
  }));
  return { states: parsed, ...sentIndex(parsed) };
}
