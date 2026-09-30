import type { LoaderFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";

const RECENT_DAYS = 5;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);

    const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString().slice(0, 10);

    const response = await admin.graphql(`
      #graphql
      query {
        orders(first: 250, query: "created_at:>=${since}") {
          edges {
            node {
              id
              createdAt
              cancelledAt
              customer {
                id
                displayName
                email
              }
            }
          }
        }
      }
    `);

    const data: any = await response.json();
    if (data?.errors) {
      console.error("Recent customers GraphQL errors:", JSON.stringify(data.errors));
      return Response.json({ customers: [], error: data.errors.map((e: any) => e.message).join(", ") });
    }
    const edges = data?.data?.orders?.edges ?? [];

    const seen = new Map<string, { customerId: string | null; customerEmail: string | null; customer: string }>();
    for (const edge of edges) {
      const o = edge.node;
      if (o.cancelledAt || !o.customer) continue;
      const key = o.customer.id || o.customer.email || o.customer.displayName;
      if (!key || seen.has(key)) continue;
      seen.set(key, {
        customerId: o.customer.id ?? null,
        customerEmail: o.customer.email ?? null,
        customer: o.customer.displayName ?? "Guest",
      });
    }

    return Response.json({ customers: [...seen.values()] });
  } catch (error: any) {
    console.error("Failed to fetch recent customers:", error);
    return Response.json({ customers: [], error: error.message ?? "Unknown error" });
  }
};
