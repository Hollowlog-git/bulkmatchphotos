import db from "../db.server";

// "unpacked" events for an undo. Built from the IDs being undone, not from
// which package an event was tagged with: events back-filled from before the
// event stream existed have no packageId, and those purchases must be undone
// too. One "unpacked" is written per purchase/order whose LATEST event is
// "packed", so the local app (which mirrors Pack Check) always ends up
// consistent, and repeating an undo writes nothing new.

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

export async function writeUnpackedEvents(
  tx: Tx,
  shop: string,
  refs: { purchaseIds: string[]; orderIds: string[]; packageId: string | null },
): Promise<number> {
  let written = 0;
  const latest = async (where: object) => {
    const rows = await tx.packEvent.findMany({ where: { shop, ...where }, orderBy: { id: "desc" } });
    const byRef = new Map<string, (typeof rows)[number]>();
    for (const e of rows) {
      const key = (e.purchaseId ?? e.orderId)!;
      if (!byRef.has(key)) byRef.set(key, e); // first seen = newest
    }
    return [...byRef.values()];
  };
  const toUndo = [
    ...(refs.purchaseIds.length ? await latest({ kind: "trademe_purchase", purchaseId: { in: refs.purchaseIds } }) : []),
    ...(refs.orderIds.length ? await latest({ kind: "shopify_order", orderId: { in: refs.orderIds } }) : []),
  ].filter((e) => e.action === "packed")
    .sort((a, b) => a.id - b.id); // undo in the order things were packed
  for (const e of toUndo) {
    await tx.packEvent.create({
      data: {
        shop, kind: e.kind, action: "unpacked", packageId: refs.packageId ?? e.packageId,
        purchaseId: e.purchaseId, groupKey: e.groupKey, quantity: e.quantity,
        orderId: e.orderId, orderName: e.orderName, salesRecordId: e.salesRecordId, lineItems: e.lineItems,
        orderLineCount: e.orderLineCount, buyerEmail: e.buyerEmail,
      },
    });
    written++;
  }
  return written;
}

// Repair: a Trade Me purchase whose latest event is "packed" but which Pack
// Check no longer holds as packed was undone without its "unpacked" event
// (the undo bug fixed alongside this). Write the missing events so the local
// app clears those ticks. Idempotent; runs at the start of each sync read.
export async function repairMissingUnpackedEvents(shop: string): Promise<number> {
  return db.$transaction(async (tx) => {
    const events = await tx.packEvent.findMany({
      where: { shop, kind: "trademe_purchase" },
      orderBy: { id: "desc" },
      select: { purchaseId: true, action: true },
    });
    const latestPacked = new Set<string>();
    const seen = new Set<string>();
    for (const e of events) {
      if (!e.purchaseId || seen.has(e.purchaseId)) continue;
      seen.add(e.purchaseId);
      if (e.action === "packed") latestPacked.add(e.purchaseId);
    }
    if (!latestPacked.size) return 0;
    const stillPacked = new Set(
      (await tx.tradeMePackedItem.findMany({ where: { shop, purchaseId: { in: [...latestPacked] } }, select: { purchaseId: true } }))
        .map((p) => p.purchaseId),
    );
    const orphaned = [...latestPacked].filter((id) => !stillPacked.has(id));
    if (!orphaned.length) return 0;
    return writeUnpackedEvents(tx, shop, { purchaseIds: orphaned, orderIds: [], packageId: null });
  });
}
