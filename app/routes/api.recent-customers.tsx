import type { LoaderFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";

// 60 days is the standard Shopify order-visibility window for the base
// read_orders scope — going further back requires Shopify's separate
// approval of the read_all_orders scope, which isn't guaranteed, so this
// is the most history we can reliably pull without extra setup.
const RECENT_DAYS = 60;
const MAX_PAGES = 10; // up to 2,500 orders

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);

    const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString().slice(0, 10);

    const seen = new Map<string, { customerId: string | null; customerEmail: string | null; customer: string }>();
    let cursor: string | null = null;
    let hasNextPage = true;
    let page = 0;

    while (hasNextPage && page < MAX_PAGES) {
      page++;
      const response = await admin.graphql(`
        #graphql
        query($cursor: String) {
          orders(first: 250, after: $cursor, query: "created_at:>=${since}") {
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
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `, { variables: { cursor } });

      const data: any = await response.json();
      if (data?.errors) {
        console.error("Recent customers GraphQL errors:", JSON.stringify(data.errors));
        return Response.json({ customers: [...seen.values()], error: data.errors.map((e: any) => e.message).join(", ") });
      }

      const edges = data?.data?.orders?.edges ?? [];
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

      hasNextPage = data?.data?.orders?.pageInfo?.hasNextPage ?? false;
      cursor = data?.data?.orders?.pageInfo?.endCursor ?? null;
    }

    return Response.json({ customers: [...seen.values()] });
  } catch (error: any) {
    console.error("Failed to fetch recent customers:", error);
    return Response.json({ customers: [], error: error.message ?? "Unknown error" });
  }
};
