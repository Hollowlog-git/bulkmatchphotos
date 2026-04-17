import type { LoaderFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(`
    #graphql
    query getUnfulfilledOrders {
      orders(
        first: 50,
        query: "fulfillment_status:unfulfilled OR fulfillment_status:partial",
        sortKey: CREATED_AT,
        reverse: true
      ) {
        edges {
          node {
            id
            name
            createdAt
            displayFulfillmentStatus
            customer {
              displayName
            }
            lineItems(first: 50) {
              edges {
                node {
                  id
                  title
                  quantity
                  sku
                  variant {
                    id
                    title
                    sku
                  }
                  image {
                    url
                    altText
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

  const orders = data.data.orders.edges.map((edge: any) => {
    const o = edge.node;
    return {
      id: o.id,
      name: o.name,
      createdAt: o.createdAt,
      status: o.displayFulfillmentStatus,
      customer: o.customer?.displayName ?? "Guest",
      lineItems: o.lineItems.edges.map((le: any) => ({
        id: le.node.id,
        title: le.node.title,
        quantity: le.node.quantity,
        sku: le.node.variant?.sku || le.node.sku || "",
        variantTitle: le.node.variant?.title,
        imageUrl: le.node.image?.url,
      })),
    };
  });

  return Response.json({ orders });
};
