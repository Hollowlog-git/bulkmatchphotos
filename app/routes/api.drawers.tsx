import type { ActionFunctionArgs, LoaderFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normaliseSku } from "../lib/sku";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const drawers = await db.drawerRange.findMany({
    where: { shop: session.shop },
    orderBy: { drawerNumber: "asc" },
  });

  return Response.json({
    drawers: drawers.map((d) => ({
      drawerNumber: d.drawerNumber,
      startSku: d.startSku,
      endSku: d.endSku,
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const { drawers } = await request.json();
    if (!Array.isArray(drawers)) {
      return Response.json({ error: "drawers must be an array" }, { status: 400 });
    }

    const cleaned = drawers
      .map((d: any) => ({
        drawerNumber: Number(d.drawerNumber),
        startSku: d.startSku ? normaliseSku(String(d.startSku)) : null,
        endSku: d.endSku ? normaliseSku(String(d.endSku)) : null,
      }))
      .filter((d) => Number.isInteger(d.drawerNumber) && d.drawerNumber > 0);

    if (!cleaned.length) {
      return Response.json(
        { error: "Add at least one drawer before saving — an empty save is refused so it can't wipe your existing config." },
        { status: 400 },
      );
    }

    // Differential upsert rather than delete-all-then-recreate: a save can
    // only ever remove the specific drawer numbers it explicitly submitted,
    // never wipe rows it didn't see (e.g. from a stale or partial load).
    const existing = await db.drawerRange.findMany({ where: { shop: session.shop } });
    const submittedNumbers = new Set(cleaned.map((d) => d.drawerNumber));
    const toDeleteIds = existing.filter((e) => !submittedNumbers.has(e.drawerNumber)).map((e) => e.id);

    await db.$transaction([
      ...(toDeleteIds.length ? [db.drawerRange.deleteMany({ where: { id: { in: toDeleteIds } } })] : []),
      ...cleaned.map((d) =>
        db.drawerRange.upsert({
          where: { shop_drawerNumber: { shop: session.shop, drawerNumber: d.drawerNumber } },
          create: { shop: session.shop, drawerNumber: d.drawerNumber, startSku: d.startSku, endSku: d.endSku },
          update: { startSku: d.startSku, endSku: d.endSku },
        }),
      ),
    ]);

    return Response.json({ success: true });
  } catch (error: any) {
    console.error("Failed to save drawer config:", error);
    return Response.json({ error: error.message ?? "Unknown error" }, { status: 500 });
  }
};
