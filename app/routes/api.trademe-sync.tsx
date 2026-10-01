import type { ActionFunctionArgs } from "@react-router/node";
import crypto from "node:crypto";
import db from "../db.server";

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
    const jobs: IncomingJob[] = Array.isArray(body?.jobs) ? body.jobs : [];

    for (const job of jobs) {
      if (!job || typeof job.groupKey !== "string" || !job.groupKey.trim()) {
        return Response.json({ error: "Every job requires a non-empty groupKey" }, { status: 400 });
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

    return Response.json({ success: true, jobsReceived: jobs.length, itemsReceived: incomingPurchaseIds.length, ...result });
  } catch (error: any) {
    console.error("[trademe-sync] Failed to process sync:", error);
    return Response.json({ error: error.message ?? "Unknown error" }, { status: 500 });
  }
};
