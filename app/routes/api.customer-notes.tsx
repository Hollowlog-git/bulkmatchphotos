import type { ActionFunctionArgs, LoaderFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const notes = await db.customerNote.findMany({
    where: { shop: session.shop, archived: false },
    orderBy: { updatedAt: "desc" },
  });

  return Response.json({
    notes: notes.map((n) => ({
      id: n.id,
      customerId: n.customerId,
      customerEmail: n.customerEmail,
      customerName: n.customerName,
      note: n.note,
      updatedAt: n.updatedAt,
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    if (request.method === "DELETE") {
      const { id } = await request.json();
      if (!id) return Response.json({ error: "id is required" }, { status: 400 });
      await db.customerNote.deleteMany({ where: { id, shop: session.shop } });
      return Response.json({ success: true });
    }

    // Archive keeps the row (unlike DELETE) — just hides it from the active
    // banner and search directory, so it can't accidentally be dropped for good.
    if (request.method === "PATCH") {
      const { id } = await request.json();
      if (!id) return Response.json({ error: "id is required" }, { status: 400 });
      await db.customerNote.updateMany({ where: { id, shop: session.shop }, data: { archived: true } });
      return Response.json({ success: true });
    }

    const body = await request.json();
    const customerId = body.customerId ? String(body.customerId) : null;
    const customerEmail = body.customerEmail ? String(body.customerEmail).trim().toLowerCase() : null;
    const customerName = String(body.customerName ?? "").trim();
    const note = String(body.note ?? "").trim();

    if (!customerName) return Response.json({ error: "customerName is required" }, { status: 400 });
    if (!note) return Response.json({ error: "note is required" }, { status: 400 });

    if (body.id) {
      const updated = await db.customerNote.update({
        where: { id: String(body.id) },
        data: { customerId, customerEmail, customerName, note },
      });
      return Response.json({ success: true, note: updated });
    }

    const created = await db.customerNote.create({
      data: { shop: session.shop, customerId, customerEmail, customerName, note },
    });
    return Response.json({ success: true, note: created });
  } catch (error: any) {
    console.error("Failed to save customer note:", error);
    return Response.json({ error: error.message ?? "Unknown error" }, { status: 500 });
  }
};
