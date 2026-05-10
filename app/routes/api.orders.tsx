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
              channelInformation {
                channelDefinition {
                  channelName
                  handle
                }
              }
              customer {
                id
                displayName
                email
                numberOfOrders
              }
              shippingLine {
                title
                originalPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                discountedPriceSet {
                  shopMoney {
                    amount
                  }
                }
              }
              shippingAddress {
                firstName
                lastName
                address1
                address2
                city
                province
                zip
                country
              }
              discountCodes
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    title
                    quantity
                    product {
                      id
                      handle
                      onlineStoreUrl
                    }
                    originalUnitPriceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    discountedUnitPriceSet {
                      shopMoney {
                        amount
                      }
                    }
                    variant {
                      sku
                      title
                      product {
                        id
                        handle
                        onlineStoreUrl
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
        const shippingOriginal = parseFloat(o.shippingLine?.originalPriceSet?.shopMoney?.amount ?? "0");
        const shippingDiscounted = parseFloat(o.shippingLine?.discountedPriceSet?.shopMoney?.amount ?? "0");
        const currencyCode = o.shippingLine?.originalPriceSet?.shopMoney?.currencyCode ?? "NZD";
        const discountCodes = (o.discountCodes ?? []) as string[];
        const hasShippingDiscount = shippingOriginal > 0 && shippingDiscounted < shippingOriginal;
        const shippingWasFree = shippingOriginal === 0;

        const sa = o.shippingAddress;
        const shippingAddress = sa ? {
          name: [sa.firstName, sa.lastName].filter(Boolean).join(" "),
          address1: sa.address1 ?? "",
          address2: sa.address2 ?? "",
          city: sa.city ?? "",
          province: sa.province ?? "",
          zip: sa.zip ?? "",
          country: sa.country ?? "",
        } : null;

        // Channel detection
        const channelName = o.channelInformation?.channelDefinition?.channelName ?? "";
        const channelHandle = o.channelInformation?.channelDefinition?.handle ?? "";
        let channel = "Unknown";
        if (channelHandle === "trade-me" || channelName.toLowerCase().includes("trade")) {
          channel = "Trade Me";
        } else if (channelHandle === "online_store" || channelName.toLowerCase().includes("online")) {
          channel = "Online Store";
        } else if (channelHandle === "shopify_shop" || channelName.toLowerCase().includes("shop")) {
          channel = "Shop App";
        } else if (channelName) {
          channel = channelName;
        } else {
          channel = "Trade Me"; // blank = Trade Me per your note
        }

        // Fulfillment orders — get open ones


        return {
          id: o.id,
          name: o.name,
          createdAt: o.createdAt,
          status: o.displayFulfillmentStatus,
          customerId: o.customer?.id ?? null,
          customer: o.customer?.displayName ?? "Guest",
          customerEmail: o.customer?.email ?? null,
          customerTotalOrders: o.customer?.numberOfOrders ?? null,
          channel,
          shippingTitle: o.shippingLine?.title ?? "No shipping selected",
          shippingAmount: shippingDiscounted,
          shippingOriginalAmount: shippingOriginal,
          shippingWasFree,
          hasShippingDiscount,
          currencyCode,
          discountCodes,
          shippingAddress,
          fulfillmentOrders: [],
          lineItems: o.lineItems.edges.map((le: any) => ({
            id: le.node.id,
            title: le.node.title,
            quantity: le.node.quantity,
            sku: le.node.variant?.sku ?? "",
            variantTitle: le.node.variant?.title,
            imageUrl: le.node.variant?.product?.featuredImage?.url ?? null,
            productUrl: le.node.variant?.product?.onlineStoreUrl ?? le.node.product?.onlineStoreUrl ?? null,
            productId: le.node.variant?.product?.id ?? le.node.product?.id ?? null,
            unitPrice: parseFloat(le.node.discountedUnitPriceSet?.shopMoney?.amount ?? le.node.originalUnitPriceSet?.shopMoney?.amount ?? "0"),
            originalUnitPrice: parseFloat(le.node.originalUnitPriceSet?.shopMoney?.amount ?? "0"),
            currencyCode: le.node.originalUnitPriceSet?.shopMoney?.currencyCode ?? currencyCode,
          })),
        };
      });

    return Response.json({ orders });

  } catch (error) {
    console.error("api/orders error:", error);
    throw error;
  }
};
