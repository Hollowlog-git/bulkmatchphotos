import type { LoaderFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";
import { redactPair, redactText } from "../lib/redact";

// Read-only, admin-only diagnostic: shows every place one Shopify order could
// carry a Trade Me purchase/listing reference, so both apps can agree how to
// map Shopify order lines to Trade Me purchases. GET only — there is no
// action, and the query reads nothing about the customer (no name, email,
// phone or address). Free-text fields are redacted (lib/redact.ts).
//
// GET /api/order-diagnostic?order=SO4392   (or #6853, or 6853)

const QUERY = `#graphql
  query OrderReferenceDiagnostic($query: String!) {
    orders(first: 1, query: $query) {
      nodes {
        id
        name
        createdAt
        sourceName
        sourceIdentifier
        tags
        note
        customAttributes { key value }
        app { id name }
        channelInformation {
          channelId
          app { id title }
          channelDefinition { handle channelName subChannelName }
        }
        metafields(first: 30) { nodes { namespace key type value } }
        lineItems(first: 100) {
          nodes {
            id
            name
            sku
            quantity
            currentQuantity
            customAttributes { key value }
            variant { id }
            product { id }
          }
        }
      }
    }
  }`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const raw = (new URL(request.url).searchParams.get("order") ?? "").trim();
  // Order names only: letters, digits, # and - (keeps the search query safe).
  if (!/^#?[A-Za-z0-9-]{1,30}$/.test(raw)) {
    return Response.json({ error: "Give an order name, e.g. SO4392 or #6853" }, { status: 400 });
  }
  const name = raw.startsWith("#") || /^[A-Za-z]/.test(raw) ? raw : `#${raw}`;

  const res = await admin.graphql(QUERY, { variables: { query: `name:${name}` } });
  const data: any = await res.json();
  if (data?.errors) {
    return Response.json({ error: "Shopify query failed", details: data.errors }, { status: 502 });
  }
  const o = data?.data?.orders?.nodes?.[0];
  if (!o) return Response.json({ error: `No order found named ${name}` }, { status: 404 });

  const pairs = (list: any[] | undefined) =>
    (list ?? []).map((a) => ({ key: a.key, value: redactPair(a.key, a.value) }));

  return Response.json({
    note: "Read-only diagnostic. Customer name, email, phone and address are not fetched; emails and phone numbers in free text are redacted.",
    order: {
      id: o.id,
      name: o.name,
      createdAt: o.createdAt,
      sourceName: o.sourceName,
      sourceIdentifier: o.sourceIdentifier ? redactText(o.sourceIdentifier) : null,
      app: o.app,
      channel: {
        channelId: o.channelInformation?.channelId ?? null,
        app: o.channelInformation?.app ?? null,
        handle: o.channelInformation?.channelDefinition?.handle ?? null,
        channelName: o.channelInformation?.channelDefinition?.channelName ?? null,
        subChannelName: o.channelInformation?.channelDefinition?.subChannelName ?? null,
      },
      tags: (o.tags ?? []).map((t: string) => redactText(t)),
      orderNote: o.note ? redactText(o.note) : null,
      customAttributes: pairs(o.customAttributes),
      metafields: (o.metafields?.nodes ?? []).map((m: any) => ({
        namespace: m.namespace,
        key: m.key,
        type: m.type,
        value: redactPair(m.key, m.value),
      })),
      lineItems: (o.lineItems?.nodes ?? []).map((li: any) => ({
        id: li.id,
        title: li.name,
        sku: li.sku,
        quantity: li.quantity,
        currentQuantity: li.currentQuantity,
        variantId: li.variant?.id ?? null,
        productId: li.product?.id ?? null,
        customAttributes: pairs(li.customAttributes),
      })),
    },
  });
};
