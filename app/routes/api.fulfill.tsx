import type { ActionFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);
    const { fulfillmentOrderIds } = await request.json();

    if (!fulfillmentOrderIds?.length) {
      return Response.json({ error: "No fulfillment order IDs provided" }, { status: 400 });
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
          fulfillmentLineItemsByFulfillmentOrder: fulfillmentOrderIds.map((id: string) => ({
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
