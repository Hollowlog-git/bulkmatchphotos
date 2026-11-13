import type { LoaderFunctionArgs } from "@react-router/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PAGE_SIZE = 50;
const MAX_ORDERS = 150;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.admin(request);

    // Shopify returns at most 50 orders per page here (each carries up to 50
    // line items), so page through, oldest first, up to MAX_ORDERS. If more
    // are waiting, Pack Check is told so it can warn instead of silently
    // leaving the newest orders out.
    const edgesAll: any[] = [];
    let after: string | null = null;
    let truncated = false;
    for (;;) {
      const response: Response = await admin.graphql(`
        #graphql
        query PackCheckOrders($after: String) {
          orders(
            first: ${PAGE_SIZE},
            after: $after,
            sortKey: CREATED_AT,
            query: "fulfillment_status:unfulfilled status:open"
          ) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                name
                createdAt
                note
                displayFulfillmentStatus
                displayFinancialStatus
                currentTotalPriceSet {
                  shopMoney {
                    amount
                  }
                }
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
      `, { variables: { after } });

      const data: any = await response.json();

      if (!data?.data?.orders) {
        console.error("No orders in response:", JSON.stringify(data, null, 2));
        if (!edgesAll.length) return Response.json({ orders: [] });
        truncated = true; // keep what we already have, but say the list is incomplete
        break;
      }

      edgesAll.push(...data.data.orders.edges);
      const pageInfo = data.data.orders.pageInfo;
      if (!pageInfo?.hasNextPage) break;
      if (edgesAll.length >= MAX_ORDERS) { truncated = true; break; }
      after = pageInfo.endCursor;
    }

    // Orders packed in Pack Check stay unfulfilled in Shopify (Pack Check
    // never fulfils), so leave them out here or they'd reappear.
    const packedIds = new Set(
      (await db.packedOrder.findMany({ where: { shop: session.shop }, select: { orderId: true } })).map((p) => p.orderId),
    );

    const orders = edgesAll.slice(0, MAX_ORDERS)
      .filter((edge: any) => !packedIds.has(edge.node.id))
      .filter((edge: any) => !edge.node.cancelledAt)
      .filter((edge: any) => edge.node.displayFinancialStatus !== "PENDING")
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
          note: o.note ?? null,
          status: o.displayFulfillmentStatus,
          financialStatus: o.displayFinancialStatus,
          totalValue: parseFloat(o.currentTotalPriceSet?.shopMoney?.amount ?? "0"),
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

    return Response.json({ orders, truncated, maxOrders: MAX_ORDERS });

  } catch (error) {
    console.error("api/orders error:", error);
    throw error;
  }
};
