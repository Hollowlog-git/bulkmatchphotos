import type { ActionFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);
    const { orderIds } = await request.json();

    if (!orderIds?.length) {
      return Response.json({ error: "No order IDs provided" }, { status: 400 });
    }

    // Fetch fulfillment order IDs for each order
    const allFulfillmentOrderIds: string[] = [];

    for (const orderId of orderIds) {
      const foResponse = await admin.graphql(`
        #graphql
        query getFulfillmentOrders($orderId: ID!) {
          order(id: $orderId) {
            fulfillmentOrders(first: 10) {
              edges {
                node {
                  id
                  status
                }
              }
            }
          }
        }
      `, { variables: { orderId } });

      const foData = await foResponse.json();
      const foEdges = foData?.data?.order?.fulfillmentOrders?.edges ?? [];
      for (const edge of foEdges) {
        if (edge.node.status === "OPEN" || edge.node.status === "IN_PROGRESS") {
          allFulfillmentOrderIds.push(edge.node.id);
        }
      }
    }

    if (!allFulfillmentOrderIds.length) {
      return Response.json({ error: "No open fulfillment orders found for these orders." }, { status: 400 });
    }

    // Create fulfillment with customer notification
    const response = await admin.graphql(`
      #graphql
      mutation fulfillmentCreate($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) {
          fulfillment {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `, {
      variables: {
        fulfillment: {
          notifyCustomer: true,
          fulfillmentLineItemsByFulfillmentOrder: allFulfillmentOrderIds.map((id: string) => ({
            fulfillmentOrderId: id,
          })),
        },
      },
    });

    const data = await response.json();
    const errors = data?.data?.fulfillmentCreate?.userErrors;

    if (errors?.length) {
      return Response.json({ error: errors.map((e: any) => e.message).join(", ") }, { status: 400 });
    }

    return Response.json({ success: true, fulfillment: data?.data?.fulfillmentCreate?.fulfillment });

  } catch (error: any) {
    console.error("Fulfillment error:", error);
    return Response.json({ error: error.message ?? "Unknown error" }, { status: 500 });
  }
};
