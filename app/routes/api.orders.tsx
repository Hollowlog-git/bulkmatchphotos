import type { LoaderFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);

    const response = await admin.graphql(`
      #graphql
      query {
        orders(first: 50, query: "fulfillment_status:unfulfilled") {
          edges {
            node {
              id
              name
              createdAt
              displayFulfillmentStatus
              customer { displayName }
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    title
                    quantity
                    variant { sku title }
                  }
                }
              }
            }
          }
        }
      }
    `);

    const data = await response.json();

    if (!data?.data?.orders) {
      console.error("No orders in response:", JSON.stringify(data, null, 2));
      return Response.json({ orders: [] });
    }

    const orders = data.data.orders.edges.map((edge: any) => ({
      id: edge.node.id,
      name: edge.node.name,
      createdAt: edge.node.createdAt,
      status: edge.node.displayFulfillmentStatus,
      customer: edge.node.customer?.displayName ?? "Guest",
      lineItems: edge.node.lineItems.edges.map((le: any) => ({
        id: le.node.id,
        title: le.node.title,
        quantity: le.node.quantity,
        sku: le.node.variant?.sku ?? "",
        variantTitle: le.node.variant?.title,
        imageUrl: null,
      })),
    }));

    return Response.json({ orders });

  } catch (error) {
    console.error("api/orders error:", error);
    throw error;
  }
};
