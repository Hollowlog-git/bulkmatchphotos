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
                email
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

        return {
          id: o.id,
          name: o.name,
          createdAt: o.createdAt,
          status: o.displayFulfillmentStatus,
          customerId: o.customer?.id ?? null,
          customer: o.customer?.displayName ?? "Guest",
          customerEmail: o.customer?.email ?? null,
          shippingTitle: o.shippingLine?.title ?? "No shipping selected",
          shippingAmount: shippingDiscounted,
          shippingOriginalAmount: shippingOriginal,
          shippingWasFree,
          hasShippingDiscount,
          currencyCode,
          discountCodes,
          shippingAddress,
          lineItems: o.lineItems.edges.map((le: any) => ({
            id: le.node.id,
            title: le.node.title,
            quantity: le.node.quantity,
            sku: le.node.variant?.sku ?? "",
            variantTitle: le.node.variant?.title,
            imageUrl: le.node.variant?.product?.featuredImage?.url ?? null,
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
