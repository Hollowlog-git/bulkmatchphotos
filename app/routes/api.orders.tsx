import type { LoaderFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);

    const response = await admin.graphql(`
      #graphql
      query {
        orders(
          first: 50,
          query: "fulfillment_status:unfulfilled status:open"
        ) {
          edges {
            node {
              id
              name
              createdAt
              displayFulfillmentStatus
              cancelledAt
              customer {
                id
                displayName
              }
              shippingLine {
                title
                originalPriceSet {
                  shopMoney {
                    amount
                  }
                }
              }
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    title
                    quantity
                    variant {
                      sku
                      title
                      product {
                        id
                        featuredImage {
                          url
                        }
                      }
                    }
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

    const orders = data.data.orders.edges
      .filter((edge: any) => !edge.node.cancelledAt)
      .map((edge: any) => {
        const o = edge.node;
        const shippingAmount = parseFloat(
          o.shippingLine?.originalPriceSet?.shopMoney?.amount ?? "0"
        );
        return {
          id: o.id,
          name: o.name,
          createdAt: o.createdAt,
          status: o.displayFulfillmentStatus,
          customerId: o.customer?.id ?? null,
          customer: o.customer?.displayName ?? "Guest",
          shippingTitle: o.shippingLine?.title ?? "No shipping",
          shippingAmount,
          lineItems: o.lineItems.edges.map((le: any) => ({
            id: le.node.id,
            title: le.node.title,
            quantity: le.node.quantity,
            sku: le.node.variant?.sku ?? "",
            variantTitle: le.node.variant?.title,
            imageUrl: le.node.variant?.product?.featuredImage?.url ?? null,
          })),
        };
      });

    return Response.json({ orders });

  } catch (error) {
    console.error("api/orders error:", error);
    throw error;
  }
};
