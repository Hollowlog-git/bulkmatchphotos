import { Badge, BlockStack, Button, Card, InlineStack, Text } from "@shopify/polaris";
import { Thumb } from "./Thumb";
import { CLEARANCE_LABEL, type Clearance } from "../lib/clearance";

// Pack Check's "Packed" view: packages recorded as packed but not yet sent,
// newest first, each with an undo that returns it to "To pack".

export interface PackedPackageView {
  id: string;
  label: string;
  packedAt: string;
  customer: string;
  email: string | null;
  tradeMeItems: number;
  orders: { id: string; name: string; channel: string; sent: boolean }[];
  items: { sku: string; title: string; quantity: number; imageUrl: string | null }[];
  clearance?: Clearance;
  remainingToPack?: number;
}

export interface LegacyPackedParcel {
  groupKey: string;
  packedAt: string;
  purchaseIds: string[];
  buyer: string | null;
  clearance?: Clearance;
  remainingToPack?: number;
}

const BADGE_TONE: Record<string, "success" | "critical" | "warning" | "attention" | undefined> = {
  cleared: "success",
  blocked: "critical",
  payment_outstanding: "warning",
  shipping_not_cleared: "attention",
  unknown: undefined,
};

// Send status for a packed parcel: packing is done, but may it be sent?
export function SendStatus({ clearance, remainingToPack }: { clearance?: Clearance; remainingToPack?: number }) {
  if (!clearance) return null;
  return (
    <InlineStack gap="200" wrap blockAlign="center">
      <Badge tone={BADGE_TONE[clearance.state]}>
        {clearance.state === "cleared" && remainingToPack ? "Cleared — but items still to pack" : CLEARANCE_LABEL[clearance.state]}
      </Badge>
      {clearance.reasons.length > 0 && <Text as="span" variant="bodySm" tone="subdued">{clearance.reasons.join(" · ")}</Text>}
      {!!remainingToPack && <Badge tone="attention">{`${remainingToPack} new item${remainingToPack !== 1 ? "s" : ""} still to pack — don't send yet`}</Badge>}
    </InlineStack>
  );
}

const GREY = { bg: "#e0e0e0", text: "#444" };

function ago(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function PackedList({ packages, legacy = [], days, loading, error, undoingId, onUndo, onUndoLegacy }: {
  packages: PackedPackageView[];
  legacy?: LegacyPackedParcel[];
  onUndoLegacy?: (parcel: LegacyPackedParcel) => void;
  days: number;
  loading: boolean;
  error: string | null;
  undoingId: string | null;
  onUndo: (pkg: PackedPackageView) => void;
}) {
  if (error) {
    return <Card><Text as="p" tone="critical">⚠️ {error}</Text></Card>;
  }
  if (!loading && packages.length === 0 && legacy.length === 0) {
    return (
      <Card>
        <Text as="p" tone="subdued">
          Nothing packed and waiting to be sent in the last {days} days.
        </Text>
      </Card>
    );
  }
  return (
    <BlockStack gap="300">
      <Text as="p" tone="subdued" variant="bodySm">
        Packed in the last {days} days and not yet sent. Each shows whether it may be sent: only send parcels marked
        "Cleared after packing". A package leaves this list once its Shopify orders are
        fulfilled. Trade Me-only packages stay for {days} days, as their dispatch is tracked in the local app.
      </Text>
      {packages.map((p) => {
        const units = p.items.reduce((s, i) => s + i.quantity, 0);
        return (
          <Card key={p.id}>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center" wrap>
                <BlockStack gap="100">
                  <Text as="h3" variant="headingMd">{p.customer || p.label}</Text>
                  <Text as="span" tone="subdued" variant="bodySm">
                    Packed {ago(p.packedAt)} · {units} item{units !== 1 ? "s" : ""}{p.email ? ` · ${p.email}` : ""}
                  </Text>
                </BlockStack>
                <Button tone="critical" loading={undoingId === p.id} onClick={() => onUndo(p)}>
                  Undo packed
                </Button>
              </InlineStack>
              <SendStatus clearance={p.clearance} remainingToPack={p.remainingToPack} />
              <InlineStack gap="200" wrap>
                {p.orders.map((o) => (
                  <Badge key={o.id} tone={o.sent ? "success" : "attention"}>
                    {`${o.name} · ${o.sent ? "sent" : "not sent"}`}
                  </Badge>
                ))}
                {p.tradeMeItems > 0 && (
                  <Badge tone="info">{`Trade Me · ${p.tradeMeItems} item${p.tradeMeItems !== 1 ? "s" : ""}`}</Badge>
                )}
              </InlineStack>
              <BlockStack gap="150">
                {p.items.map((i, idx) => (
                  <InlineStack key={`${i.sku}-${idx}`} gap="300" blockAlign="center" wrap={false}>
                    <Thumb src={i.imageUrl} sku={i.sku} title={i.title} size={36} radius={5} fontSize={10} colour={GREY} />
                    <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 13, minWidth: 90 }}>{i.sku || "—"}</div>
                    <div style={{ flex: 1, minWidth: 0, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{i.title}</div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>×{i.quantity}</div>
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        );
      })}
      {legacy.length > 0 && (
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Trade Me items packed without a package record</Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Packed with the earlier "Mark Trade Me job as packed" button, so only their purchase IDs were kept.
          </Text>
          {legacy.map((l) => (
            <Card key={l.groupKey}>
              <InlineStack align="space-between" blockAlign="center" wrap>
                <BlockStack gap="100">
                  <Text as="h3" variant="headingMd">{l.buyer ?? `Trade Me parcel ${l.groupKey}`}</Text>
                  <Text as="span" tone="subdued" variant="bodySm">
                    Packed {ago(l.packedAt)} · {l.purchaseIds.length} item{l.purchaseIds.length !== 1 ? "s" : ""} · parcel {l.groupKey}
                  </Text>
                  <Text as="span" tone="subdued" variant="bodySm">Purchases: {l.purchaseIds.join(", ")}</Text>
                  <SendStatus clearance={l.clearance} remainingToPack={l.remainingToPack} />
                </BlockStack>
                {onUndoLegacy && (
                  <Button tone="critical" loading={undoingId === `legacy:${l.groupKey}`} onClick={() => onUndoLegacy(l)}>
                    Undo packed
                  </Button>
                )}
              </InlineStack>
            </Card>
          ))}
        </BlockStack>
      )}
    </BlockStack>
  );
}
