import type { Route } from "./+types/app.drafts";
import React from "react";
import { useFetcher, useLoaderData } from "react-router";
import {
  Page,
  Card,
  ResourceList,
  ResourceItem,
  Text,
  InlineStack,
  BlockStack,
  DropZone,
  Banner,
  Button,
  Badge,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

/* ---------------- LOADER ---------------- */

export async function loader({ request }: Route.LoaderArgs) {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const after = url.searchParams.get("after"); // cursor for pagination
  const first = Number(url.searchParams.get("first") || "20");

  const query = `
    query DraftProducts($first: Int!, $after: String) {
      shop {
        myshopifyDomain
      }
      products(
        first: $first
        after: $after
        query: "status:DRAFT"
        sortKey: UPDATED_AT
        reverse: true
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            legacyResourceId
            title
            status
            images(first: 2) {
              edges {
                node {
                  url
                  altText
                }
              }
            }
            variants(first: 1) {
              edges {
                node {
                  id
                  price
                  taxable
                  inventoryItem {
                    measurement {
                      weight {
                        value
                        unit
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
  `;

  const res = await admin.graphql(query, {
    variables: { first, after },
  });
  const data = await res.json();

  const products = data.data.products.edges.map((e: any) => e.node);
  const pageInfo = data.data.products.pageInfo;
  const shopDomain = data.data.shop.myshopifyDomain as string;

  return Response.json({
    shopDomain,
    products,
    pageInfo,
  });
}

/* ---------------- ACTION (images only) ---------------- */

export async function action({ request }: Route.ActionArgs) {
  const { admin } = await authenticate.admin(request);

  const form = await request.formData();
  const productId = String(form.get("productId") || "");
  const files = form.getAll("files").filter(Boolean) as File[];

  if (!productId) {
    return Response.json({ ok: false, error: "Missing productId" }, { status: 400 });
  }
  if (!files.length) {
    return Response.json({ ok: false, error: "No files provided" }, { status: 400 });
  }

  try {
    const stagedUploadsCreate = `
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { message }
        }
      }
    `;

    const stagedRes = await admin.graphql(stagedUploadsCreate, {
      variables: {
        input: files.map((f) => ({
          filename: f.name,
          mimeType: f.type || "image/jpeg",
          resource: "IMAGE",
          httpMethod: "POST",
        })),
      },
    });

    const stagedJson = await stagedRes.json();
    const stagedErrs = stagedJson?.data?.stagedUploadsCreate?.userErrors;

    if (stagedErrs?.length) {
      return Response.json(
        { ok: false, error: stagedErrs.map((e: any) => e.message).join(", ") },
        { status: 400 }
      );
    }

    const targets = stagedJson.data.stagedUploadsCreate.stagedTargets as Array<{
      url: string;
      resourceUrl: string;
      parameters: Array<{ name: string; value: string }>;
    }>;

    const uploaded: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const target = targets[i];
      const file = files[i];

      const fd = new FormData();
      target.parameters.forEach((p) => fd.append(p.name, p.value));
      fd.append("file", file);

      const uploadRes = await fetch(target.url, { method: "POST", body: fd });
      if (!uploadRes.ok) {
        const text = await uploadRes.text().catch(() => "");
        throw new Error(`Upload failed: ${uploadRes.status} ${text}`);
      }

      uploaded.push(target.resourceUrl);
    }

    const productCreateMedia = `
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          mediaUserErrors { message }
        }
      }
    `;

    const attachRes = await admin.graphql(productCreateMedia, {
      variables: {
        productId,
        media: uploaded.map((u) => ({
          mediaContentType: "IMAGE",
          originalSource: u,
        })),
      },
    });

    const attachJson = await attachRes.json();
    const attachErrs = attachJson?.data?.productCreateMedia?.mediaUserErrors;

    if (attachErrs?.length) {
      return Response.json(
        { ok: false, error: attachErrs.map((e: any) => e.message).join(", ") },
        { status: 400 }
      );
    }

    return Response.json({ ok: true, attached: files.length, productId });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || "Upload failed" }, { status: 500 });
  }
}

/* ---------------- UI ---------------- */

export default function DraftsPage() {
  const { products: initialProducts, pageInfo, shopDomain } = useLoaderData<typeof loader>();

  // Keep an appended list client-side (so Load more doesn’t redraw everything)
  const [products, setProducts] = React.useState<any[]>(initialProducts as any[]);
  const [endCursor, setEndCursor] = React.useState<string | null>(pageInfo?.endCursor ?? null);
  const [hasNextPage, setHasNextPage] = React.useState<boolean>(!!pageInfo?.hasNextPage);

  // Fetcher for “Load more”
  const moreFetcher = useFetcher<typeof loader>();
  const loadingMore = moreFetcher.state !== "idle";

  React.useEffect(() => {
    if (!moreFetcher.data) return;

    const nextProducts = (moreFetcher.data.products as any[]) ?? [];
    const nextPageInfo = (moreFetcher.data.pageInfo as any) ?? {};

    // Append without duplicates (just in case)
    setProducts((prev) => {
      const existing = new Set(prev.map((p) => p.id));
      const merged = [...prev];
      for (const p of nextProducts) if (!existing.has(p.id)) merged.push(p);
      return merged;
    });

    setEndCursor(nextPageInfo.endCursor ?? null);
    setHasNextPage(!!nextPageInfo.hasNextPage);
  }, [moreFetcher.data]);

  const onLoadMore = () => {
    if (!hasNextPage || !endCursor || loadingMore) return;
    moreFetcher.load(`/app/drafts?first=20&after=${encodeURIComponent(endCursor)}`);
  };

  return (
    <Page title="Draft products – drag & drop photos">
      <Card>
        <ResourceList
          resourceName={{ singular: "product", plural: "products" }}
          items={products as any[]}
          renderItem={(item: any) => <ProductRow item={item} shopDomain={shopDomain} />}
        />

        <Divider />

        <div style={{ padding: 16 }}>
          <InlineStack align="space-between" blockAlign="center">
            <Text as="p" tone="subdued">
              Showing {products.length} draft product{products.length === 1 ? "" : "s"}
            </Text>

            <Button onClick={onLoadMore} disabled={!hasNextPage || loadingMore}>
              {loadingMore ? "Loading…" : hasNextPage ? "Load 20 more" : "All loaded"}
            </Button>
          </InlineStack>
        </div>
      </Card>
    </Page>
  );
}

function BigThumb({
  src,
  alt,
  fallback,
}: {
  src?: string;
  alt: string;
  fallback: string;
}) {
  const box: React.CSSProperties = {
    width: 120,
    height: 120,
    borderRadius: 12,
    border: "1px solid #e1e3e5",
    background: "#f6f6f7",
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };

  if (!src) {
    return (
      <div style={box}>
        <span style={{ fontSize: 12, color: "#6d7175", textAlign: "center" }}>
          {fallback}
        </span>
      </div>
    );
  }

  return (
    <div style={box}>
      <img
        src={src}
        alt={alt}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block",
        }}
      />
    </div>
  );
}

function formatWeight(variant: any) {
  const w = variant?.inventoryItem?.measurement?.weight;
  const value = w?.value;

  // Treat 0/undefined as “—” to avoid clutter
  if (typeof value !== "number" || value <= 0) return "—";

  const unit = String(w?.unit || "").toLowerCase();
  return unit ? `${value} ${unit}` : String(value);
}

function adminProductUrl(shopDomain: string, legacyResourceId: string | number | null | undefined) {
  if (!shopDomain || !legacyResourceId) return null;
  return `https://${shopDomain}/admin/products/${legacyResourceId}`;
}

function ProductRow({
  item,
  shopDomain,
}: {
  item: any;
  shopDomain: string;
}) {
  // Row-scoped fetcher keeps uploads independent
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data as any;

  const images = item.images?.edges?.map((e: any) => e.node) ?? [];
  const variant = item.variants?.edges?.[0]?.node;

  const price = variant?.price ?? "—";
  const taxable =
    typeof variant?.taxable === "boolean" ? (variant.taxable ? "Yes" : "No") : "—";
  const weightText = formatWeight(variant);

  const openUrl = adminProductUrl(shopDomain, item.legacyResourceId);

  const onDrop = (files: File[]) => {
    const fd = new FormData();
    fd.append("productId", item.id);
    files.forEach((f) => fd.append("files", f));
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  };

  const showSuccess =
    result?.ok === true && result?.productId === item.id && typeof result?.attached === "number";

  const showError =
    result?.ok === false && (result?.productId === item.id || !result?.productId);

  return (
    <ResourceItem id={item.id}>
      <InlineStack align="space-between" blockAlign="center" gap="500">
        {/* Left: large thumbs + info */}
        <InlineStack gap="400" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <BigThumb
              src={images[0]?.url}
              alt={images[0]?.altText || item.title}
              fallback="No photo"
            />
            <BigThumb
              src={images[1]?.url}
              alt={images[1]?.altText || item.title}
              fallback="No photo"
            />
          </InlineStack>

          <BlockStack gap="150">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="bodyMd" fontWeight="semibold">
                {item.title}
              </Text>
              <Badge tone="info">{item.status}</Badge>
            </InlineStack>

            <InlineStack gap="400">
              <Text as="p" tone="subdued">
                Price: {price}
              </Text>
              <Text as="p" tone="subdued">
                Weight: {weightText}
              </Text>
              <Text as="p" tone="subdued">
                Taxable: {taxable}
              </Text>
            </InlineStack>

            {openUrl && (
              <div>
                <Button variant="plain" url={openUrl} external>
                  Open in Shopify
                </Button>
              </div>
            )}

            {showError && (
              <Banner tone="critical" title="Upload failed">
                <p>{result.error}</p>
              </Banner>
            )}
          </BlockStack>
        </InlineStack>

        {/* Right: DropZone + lightweight status */}
        <div style={{ width: 340, minHeight: 150 }}>
          <BlockStack gap="150">
            <DropZone accept="image/*" allowMultiple disabled={busy} onDrop={onDrop}>
              <DropZone.FileUpload actionTitle="Drop photos" actionHint="or click to choose" />
            </DropZone>

            {busy && (
              <Text as="p" tone="subdued">
                Uploading…
              </Text>
            )}

            {showSuccess && !busy && (
              <Text as="p" tone="success">
                ✓ Attached {result.attached} photo{result.attached === 1 ? "" : "s"}
              </Text>
            )}
          </BlockStack>
        </div>
      </InlineStack>
    </ResourceItem>
  );
}
