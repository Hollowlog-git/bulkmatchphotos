import type { ActionFunctionArgs, LoaderFunctionArgs } from "@react-router/node";
import crypto from "node:crypto";
import db from "../db.server";
import { sanitiseTradeMeImageUrl } from "../lib/tradeMeImage";
import { decodeCursor, encodeCursor, serialiseEvent, tradeMeChannelAppIds } from "../lib/packEvents";
import { reportPendingShopifyOrders } from "../lib/shopifyOrderEvents.server";
import { repairMissingUnpackedEvents } from "../lib/unpack.server";

// Prepacking contract v1: unpaid wins may be packed; clearance to send is
// reported per parcel. See docs/trademe-sync.md.
const PREPACKING_CONTRACT_VERSION = 1;
import { unauthenticated } from "../shopify.server";

interface IncomingItem {
  purchaseId: string;
  listingId?: string | null;
  sku?: string | null;
  title?: string | null;
  quantity?: number | null;
  salePrice?: number | null;
  shippingPrice?: number | null;
  soldDate?: string | null;
  saleChannel?: string | null;
  packed?: boolean | null;
  // Optional (older clients omit it). Empty, invalid or non-Trade Me URLs are
  // stored as null rather than rejecting the sync.
  imageUrl?: string | null;
}
interface IncomingJob {
  groupKey: string;
  buyerUsername?: string | null;
  buyerMemberId?: string | null;
  buyerName?: string | null;
  buyerEmail?: string | null;
  deliveryAddress?: string | null;
  fulfilmentChannel: string;
  readiness?: string | null;
  kanbanCol?: string | null;
  // Prepacking contract v1 (only read when the body says
  // prepackingContractVersion: 1).
  paymentStatus?: string | null;
  shippingStatus?: string | null;
  dispatchClearance?: string | null;
  dispatchBlockers?: string[] | null;
  itemCount?: number | null;
  totalSale?: number | null;
  shippingPaid?: number | null;
  paidTotal?: number | null;
  items: IncomingItem[];
}

function authorised(request: Request): boolean {
  const expected = process.env.TRADEME_SYNC_SECRET;
  if (!expected) return false;
  const header = request.headers.get("Authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "POST only" }, { status: 405 });
  }
  if (!authorised(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shop = process.env.SHOP_DOMAIN;
  if (!shop) {
    console.error("[trademe-sync] SHOP_DOMAIN is not configured");
    return Response.json({ error: "Server misconfigured: SHOP_DOMAIN not set" }, { status: 500 });
  }

  try {
    const body: any = await request.json();
    if (!Array.isArray(body?.jobs)) {
      return Response.json({ error: "Body must be { jobs: [...] }" }, { status: 400 });
    }
    const jobs: IncomingJob[] = body.jobs;
    const v1 = body?.prepackingContractVersion === PREPACKING_CONTRACT_VERSION;
    if (body?.prepackingContractVersion !== undefined && !v1) {
      return Response.json({ error: `Unsupported prepackingContractVersion; this server supports ${PREPACKING_CONTRACT_VERSION}` }, { status: 400 });
    }

    // An empty snapshot deletes every stored job. That is legitimate when
    // nothing is ready to pack, but it is also what a bug or a failed read in
    // the local app looks like — so require the caller to say it means it.
    if (jobs.length === 0 && body?.allowEmpty !== true) {
      return Response.json(
        { error: "Refusing empty snapshot (it would remove every job). Send allowEmpty: true if nothing is ready to pack." },
        { status: 400 },
      );
    }

    for (const job of jobs) {
      if (!job || typeof job.groupKey !== "string" || !job.groupKey.trim()) {
        return Response.json({ error: "Every job requires a non-empty groupKey" }, { status: 400 });
      }
      if (v1) {
        const shortStr = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.length <= 50);
        if (!shortStr(job.paymentStatus) || !shortStr(job.shippingStatus)) {
          return Response.json({ error: `Job ${job.groupKey}: paymentStatus/shippingStatus must be short strings` }, { status: 400 });
        }
        if (job.dispatchClearance !== undefined && job.dispatchClearance !== null && job.dispatchClearance !== "cleared" && job.dispatchClearance !== "blocked") {
          return Response.json({ error: `Job ${job.groupKey}: dispatchClearance must be "cleared" or "blocked"` }, { status: 400 });
        }
        if (job.dispatchBlockers !== undefined && job.dispatchBlockers !== null
          && (!Array.isArray(job.dispatchBlockers) || !job.dispatchBlockers.every((b) => typeof b === "string" && b.length <= 50))) {
          return Response.json({ error: `Job ${job.groupKey}: dispatchBlockers must be an array of codes` }, { status: 400 });
        }
      }
      if (!Array.isArray(job.items)) {
        return Response.json({ error: `Job ${job.groupKey} is missing an items array` }, { status: 400 });
      }
      for (const item of job.items) {
        if (!item || typeof item.purchaseId !== "string" || !item.purchaseId.trim()) {
          return Response.json({ error: `Job ${job.groupKey} has an item with no purchaseId` }, { status: 400 });
        }
      }
    }

    const incomingGroupKeys = jobs.map((j) => j.groupKey.trim());
    const incomingPurchaseIds = jobs.flatMap((j) => j.items.map((i) => i.purchaseId.trim()));

    const result = await db.$transaction(async (tx) => {
      // Full-snapshot semantics: this mirror is disposable and re-derivable
      // from the local app at any time, so anything not in the latest push
      // is retracted (refunded/held/cancelled/dispatched since last sync).
      const deletedItems = await tx.tradeMeJobItem.deleteMany({
        where: {
          job: { shop },
          purchaseId: incomingPurchaseIds.length ? { notIn: incomingPurchaseIds } : undefined,
        },
      });
      const deletedJobs = await tx.tradeMeJob.deleteMany({
        where: {
          shop,
          groupKey: incomingGroupKeys.length ? { notIn: incomingGroupKeys } : undefined,
        },
      });

      for (const job of jobs) {
        const groupKey = job.groupKey.trim();
        const savedJob = await tx.tradeMeJob.upsert({
          where: { shop_groupKey: { shop, groupKey } },
          create: {
            shop,
            groupKey,
            buyerUsername: job.buyerUsername || null,
            buyerMemberId: job.buyerMemberId || null,
            buyerName: job.buyerName || null,
            buyerEmail: job.buyerEmail ? job.buyerEmail.trim().toLowerCase() : null,
            deliveryAddress: job.deliveryAddress || null,
            fulfilmentChannel: job.fulfilmentChannel,
            readiness: job.readiness || null,
            kanbanCol: job.kanbanCol || null,
            // v1 clearance; null (= unknown, never cleared) for older clients.
            // Refreshed on every full snapshot.
            paymentStatus: v1 ? job.paymentStatus ?? null : null,
            shippingStatus: v1 ? job.shippingStatus ?? null : null,
            dispatchClearance: v1 ? job.dispatchClearance ?? null : null,
            dispatchBlockers: v1 && job.dispatchBlockers ? JSON.stringify(job.dispatchBlockers) : null,
            itemCount: job.itemCount ?? job.items.length,
            totalSale: job.totalSale ?? 0,
            shippingPaid: job.shippingPaid ?? 0,
            paidTotal: job.paidTotal ?? null,
          },
          update: {
            buyerUsername: job.buyerUsername || null,
            buyerMemberId: job.buyerMemberId || null,
            buyerName: job.buyerName || null,
            buyerEmail: job.buyerEmail ? job.buyerEmail.trim().toLowerCase() : null,
            deliveryAddress: job.deliveryAddress || null,
            fulfilmentChannel: job.fulfilmentChannel,
            readiness: job.readiness || null,
            kanbanCol: job.kanbanCol || null,
            // v1 clearance; null (= unknown, never cleared) for older clients.
            // Refreshed on every full snapshot.
            paymentStatus: v1 ? job.paymentStatus ?? null : null,
            shippingStatus: v1 ? job.shippingStatus ?? null : null,
            dispatchClearance: v1 ? job.dispatchClearance ?? null : null,
            dispatchBlockers: v1 && job.dispatchBlockers ? JSON.stringify(job.dispatchBlockers) : null,
            itemCount: job.itemCount ?? job.items.length,
            totalSale: job.totalSale ?? 0,
            shippingPaid: job.shippingPaid ?? 0,
            paidTotal: job.paidTotal ?? null,
          },
        });

        for (const item of job.items) {
          const purchaseId = item.purchaseId.trim();
          await tx.tradeMeJobItem.upsert({
            where: { purchaseId },
            create: {
              purchaseId,
              jobId: savedJob.id,
              listingId: item.listingId || null,
              sku: item.sku || null,
              title: item.title || null,
              quantity: item.quantity ?? 1,
              salePrice: item.salePrice ?? 0,
              shippingPrice: item.shippingPrice ?? 0,
              soldDate: item.soldDate || null,
              saleChannel: item.saleChannel || null,
              packed: Boolean(item.packed),
              imageUrl: sanitiseTradeMeImageUrl(item.imageUrl),
            },
            update: {
              jobId: savedJob.id,
              listingId: item.listingId || null,
              sku: item.sku || null,
              title: item.title || null,
              quantity: item.quantity ?? 1,
              salePrice: item.salePrice ?? 0,
              shippingPrice: item.shippingPrice ?? 0,
              soldDate: item.soldDate || null,
              saleChannel: item.saleChannel || null,
              packed: Boolean(item.packed),
              imageUrl: sanitiseTradeMeImageUrl(item.imageUrl),
            },
          });
        }
      }

      return { deletedJobs: deletedJobs.count, deletedItems: deletedItems.count };
    });

    console.log(
      `[trademe-sync] POST shop=${shop} jobs_in=${jobs.length} items_in=${incomingPurchaseIds.length} ` +
      `deleted_jobs=${result.deletedJobs} deleted_items=${result.deletedItems}`,
    );

    return Response.json({
      success: true,
      prepackingContractVersion: PREPACKING_CONTRACT_VERSION,
      jobsReceived: jobs.length,
      itemsReceived: incomingPurchaseIds.length,
      ...result,
    });
  } catch (error: any) {
    console.error("[trademe-sync] Failed to process sync:", error);
    return Response.json({ error: error.message ?? "Unknown error" }, { status: 500 });
  }
};

// GET: the local app reads back what Pack Check has packed.
//
// Event stream (preferred): GET ?after=<cursor>&limit=<1-500, default 200>
//   -> { events: [...], cursor, hasMore }
//   Events are returned in a strict order; `cursor` is the position of the
//   last event in this page (or the cursor you sent, if the page is empty).
//   Store it after processing the page and send it back as `after` to get
//   the next page; repeat while hasMore is true. Omit `after` to start from
//   the beginning. Events are never deleted, so replaying from the start
//   is always possible. See lib/packEvents.ts for the event shapes.
//
// Legacy fields (unchanged for existing clients; ?since=<ISO> filters them):
//   packed:              Trade Me purchases recorded as packed
//   packedShopifyOrders: packed Shopify orders from the confirmed Trade Me
//                        channel only (none while it isn't configured)
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!authorised(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const shop = process.env.SHOP_DOMAIN;
  if (!shop) {
    return Response.json({ error: "Server misconfigured: SHOP_DOMAIN not set" }, { status: 500 });
  }

  const params = new URL(request.url).searchParams;
  const sinceRaw = params.get("since");
  const since = sinceRaw ? new Date(sinceRaw) : null;
  if (since && Number.isNaN(since.getTime())) {
    return Response.json({ error: "since must be an ISO date" }, { status: 400 });
  }
  const after = decodeCursor(params.get("after"));
  if (after === null) {
    return Response.json({ error: "Invalid cursor: send back the cursor value exactly as received" }, { status: 400 });
  }
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return Response.json({ error: `limit must be an integer from 1 to ${MAX_LIMIT}` }, { status: 400 });
  }

  // Write any "unpacked" events an earlier undo missed (see lib/unpack.server.ts).
  const repairedUnpacked = await repairMissingUnpackedEvents(shop);
  if (repairedUnpacked) console.log(`[trademe-sync] repaired ${repairedUnpacked} missing unpacked event(s)`);

  // Report packed Shopify orders that haven't been reported yet (including
  // ones packed before the Trade Me channel was configured), so they're in
  // this read. If Shopify can't be reached they stay pending, nothing is
  // lost, and the response says how many are still waiting.
  let shopifyReport: any;
  try {
    const { admin } = await unauthenticated.admin(shop);
    shopifyReport = await reportPendingShopifyOrders(shop, admin.graphql);
  } catch (e: any) {
    console.error("[trademe-sync] reporting packed Shopify orders failed:", e?.message);
    shopifyReport = {
      error: "Couldn't check packed Shopify orders with Shopify; they'll be reported on a later sync",
      stillPending: await db.packedOrder.count({ where: { shop, reportState: null } }),
    };
  }

  const channelIds = tradeMeChannelAppIds();
  const packedWhere = { shop, ...(since ? { packedAt: { gt: since } } : {}) };
  const [page, packed, packedOrders] = await Promise.all([
    db.packEvent.findMany({ where: { shop, id: { gt: after } }, orderBy: { id: "asc" }, take: limit + 1 }),
    db.tradeMePackedItem.findMany({ where: packedWhere, orderBy: { packedAt: "asc" } }),
    channelIds.length
      ? db.packedOrder.findMany({ where: { ...packedWhere, reportState: "reported" }, orderBy: { packedAt: "asc" } })
      : Promise.resolve([]),
  ]);
  const hasMore = page.length > limit;
  const events = page.slice(0, limit);

  return Response.json({
    // Advertised only now that storage, packing, revalidation and the
    // send-status display all support it (see docs/trademe-sync.md).
    prepackingContractVersion: PREPACKING_CONTRACT_VERSION,
    events: events.map(serialiseEvent),
    cursor: encodeCursor(events.length ? events[events.length - 1].id : after),
    hasMore,
    tradeMeChannelConfigured: channelIds.length > 0,
    // stillPending > 0: some packed Shopify orders aren't reported yet (the
    // channel is unset, or Shopify couldn't be checked). Read again later.
    shopifyOrdersPendingReport: shopifyReport.stillPending ?? 0,
    ...(shopifyReport.error ? { shopifyReportError: shopifyReport.error } : {}),
    packed: packed.map((p) => ({ purchaseId: p.purchaseId, groupKey: p.groupKey, packedAt: p.packedAt.toISOString() })),
    packedShopifyOrders: packedOrders.map((o) => ({ orderId: o.orderId, orderName: o.orderName, packedAt: o.packedAt.toISOString() })),
  });
};
