import { Badge, BlockStack, Button, Card, InlineStack, Text } from "@shopify/polaris";
import { Thumb } from "./Thumb";
import { CLEARANCE_LABEL, type Clearance } from "../lib/clearance";
import { bagVerdict } from "../lib/bagVerdict";

// Pack Check's "Packed" and "Ready to ship" views. A bag (packages filed
// together) is Ready to ship only when everything's packed, nothing from the
// same buyer is waiting elsewhere, and payment + shipping are cleared
// (lib/bagVerdict.ts). Everything else is Packed, with "Don't send yet"
// reasons. Undo returns a package to To pack.

export interface ShipTo { source: string; name: string | null; username: string | null; lines: string[] }

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
  possibleAdditions?: number;
  bagId?: string;
  bagCode?: string;
  shipTo?: ShipTo[];
  identity?: { usernames?: string[]; emails?: string[] };
}

export interface LegacyPackedParcel {
  groupKey: string;
  packedAt: string;
  purchaseIds: string[];
  buyer: string | null;
  clearance?: Clearance;
  remainingToPack?: number;
  possibleAdditions?: number;
  shipTo?: ShipTo[];
}

const BADGE_TONE: Record<string, "success" | "critical" | "warning" | "attention" | undefined> = {
  cleared: "success",
  blocked: "critical",
  payment_outstanding: "warning",
  shipping_not_cleared: "attention",
  unknown: undefined,
};

// One plain verdict for a bag, plus the payment/shipping detail.
export function SendStatus({ pkgs }: { pkgs: { clearance?: Clearance; remainingToPack?: number; possibleAdditions?: number }[] }) {
  const v = bagVerdict(pkgs);
  return (
    <BlockStack gap="100">
      <div style={{ fontWeight: 700, fontSize: 14, color: v.ready ? "#047857" : "#b91c1c" }}>
        {v.ready ? "✅ OK to send" : `🚫 Don't send yet — ${v.holds.join("; ")}`}
      </div>
      <InlineStack gap="200" wrap blockAlign="center">
        <Badge tone={BADGE_TONE[v.clearance.state]}>{CLEARANCE_LABEL[v.clearance.state]}</Badge>
        {v.clearance.reasons.length > 0 && <Text as="span" variant="bodySm" tone="subdued">{v.clearance.reasons.join(" · ")}</Text>}
      </InlineStack>
    </BlockStack>
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

// ── Bags ────────────────────────────────────────────────────────────────
interface BagView {
  key: string;
  code: string;
  name: string;
  usernames: string[];
  emails: string[];
  packedAt: string; // first packed
  pkgs: PackedPackageView[]; // newest first
  legacy: LegacyPackedParcel | null;
  shipTo: ShipTo[];
  orderNames: string[];
  items: { sku: string; title: string; quantity: number; imageUrl: string | null }[];
  ready: boolean;
}

function uniqueShipTo(list: ShipTo[]): ShipTo[] {
  const out: ShipTo[] = [];
  for (const t of list) {
    const k = t.lines.join("|").toLowerCase();
    const e = out.find((o) => o.lines.join("|").toLowerCase() === k);
    if (e) { e.username ??= t.username; e.name ??= t.name; } else out.push({ ...t });
  }
  return out;
}

export function buildBags(packages: PackedPackageView[], legacy: LegacyPackedParcel[] = []): BagView[] {
  const map = new Map<string, PackedPackageView[]>();
  for (const p of packages) map.set(p.bagId ?? p.id, [...(map.get(p.bagId ?? p.id) ?? []), p]);
  const bags: BagView[] = [...map.entries()].map(([key, pkgs]) => {
    const first = pkgs[pkgs.length - 1];
    const shipTo = uniqueShipTo(pkgs.flatMap((p) => p.shipTo ?? []));
    return {
      key,
      code: first.bagCode ?? key,
      name: first.customer || first.label,
      usernames: [...new Set([...pkgs.flatMap((p) => p.identity?.usernames ?? []), ...shipTo.map((s) => s.username).filter((u): u is string => !!u)])],
      emails: [...new Set(pkgs.flatMap((p) => [...(p.identity?.emails ?? []), ...(p.email ? [p.email] : [])]))],
      packedAt: first.packedAt,
      pkgs,
      legacy: null,
      shipTo,
      orderNames: pkgs.flatMap((p) => p.orders.map((o) => o.name)),
      items: pkgs.flatMap((p) => p.items),
      ready: bagVerdict(pkgs).ready,
    };
  });
  for (const l of legacy) {
    const shipTo = uniqueShipTo(l.shipTo ?? []);
    bags.push({
      key: `legacy:${l.groupKey}`,
      code: `PARCEL-${l.groupKey}`,
      name: l.buyer ?? `Trade Me parcel ${l.groupKey}`,
      usernames: shipTo.map((s) => s.username).filter((u): u is string => !!u),
      emails: [],
      packedAt: l.packedAt,
      pkgs: [],
      legacy: l,
      shipTo,
      orderNames: [],
      items: l.purchaseIds.map((id) => ({ sku: "", title: `Trade Me purchase ${id}`, quantity: 1, imageUrl: null })),
      ready: bagVerdict([l]).ready,
    });
  }
  return bags.sort((a, b) => b.packedAt.localeCompare(a.packedAt));
}

export function bagCounts(packages: PackedPackageView[], legacy: LegacyPackedParcel[] = []) {
  const bags = buildBags(packages, legacy);
  return { packed: bags.filter((b) => !b.ready).length, ready: bags.filter((b) => b.ready).length };
}

// Search across everything a packer might type: name, Trade Me username,
// email, bag code, order number, SKU, card title, address.
function matchesQuery(bag: BagView, query: string) {
  const hay = [
    bag.code, bag.name, ...bag.usernames, ...bag.emails, ...bag.orderNames,
    ...bag.items.flatMap((i) => [i.sku, i.title]),
    ...bag.shipTo.flatMap((s) => [s.name ?? "", s.username ?? "", ...s.lines]),
  ].join(" ").toLowerCase();
  return query.toLowerCase().replace(/#/g, " ").split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function Address({ shipTo }: { shipTo: ShipTo[] }) {
  if (!shipTo.length) return <Text as="span" tone="critical" variant="bodySm">No delivery address on record — check before sending</Text>;
  return (
    <BlockStack gap="150">
      {shipTo.length > 1 && <Text as="span" tone="critical" variant="bodySm" fontWeight="semibold">⚠️ {shipTo.length} different addresses — check before sending</Text>}
      {shipTo.map((s, i) => (
        <div key={i} style={{ fontSize: 14, lineHeight: 1.45 }}>
          <div style={{ fontWeight: 700 }}>
            {s.name ?? ""}{s.username ? <span style={{ fontWeight: 600, color: "#00547a" }}>{s.name ? " · " : ""}Trade Me: {s.username}</span> : null}
          </div>
          {s.lines.map((line, j) => <div key={j}>{line}</div>)}
        </div>
      ))}
    </BlockStack>
  );
}

export function PackedList({ packages, legacy = [], days, loading, error, undoingId, onUndo, onUndoLegacy, mode = "packed", query = "" }: {
  packages: PackedPackageView[];
  legacy?: LegacyPackedParcel[];
  onUndoLegacy?: (parcel: LegacyPackedParcel) => void;
  days: number;
  loading: boolean;
  error: string | null;
  undoingId: string | null;
  onUndo: (pkg: PackedPackageView) => void;
  mode?: "packed" | "ready";
  query?: string;
}) {
  if (error) return <Card><Text as="p" tone="critical">⚠️ {error}</Text></Card>;

  const all = buildBags(packages, legacy).filter((b) => (mode === "ready" ? b.ready : !b.ready));
  const bags = query.trim() ? all.filter((b) => matchesQuery(b, query)) : all;

  if (!loading && bags.length === 0) {
    return (
      <Card>
        <Text as="p" tone="subdued">
          {query.trim() ? `Nothing matches "${query}".`
            : mode === "ready" ? "Nothing is ready to ship yet. Bags appear here once they're fully packed, paid and shipping-cleared."
            : `Nothing packed and waiting in the last ${days} days.`}
        </Text>
      </Card>
    );
  }

  // ── Ready to ship: a compact list with addresses ──
  if (mode === "ready") {
    return (
      <BlockStack gap="200">
        <Text as="p" tone="subdued" variant="bodySm">
          Fully packed, paid and shipping-cleared. {bags.length} bag{bags.length !== 1 ? "s" : ""} ready to send.
        </Text>
        <Card padding="0">
          {bags.map((b, idx) => {
            const units = b.items.reduce((n, i) => n + i.quantity, 0);
            return (
              <div key={b.key} style={{ display: "grid", gridTemplateColumns: "minmax(140px, 1fr) minmax(220px, 2fr) minmax(160px, 1.5fr)", gap: 16, padding: "14px 18px", borderTop: idx ? "1px solid #e3e3e3" : "none", alignItems: "start" }}>
                <BlockStack gap="100">
                  <span style={{ fontFamily: "monospace", fontWeight: 800, fontSize: 14, background: "#ecfdf5", color: "#047857", padding: "2px 8px", borderRadius: 4, alignSelf: "flex-start" }}>{b.code}</span>
                  <Text as="span" variant="bodySm" tone="subdued">Packed {ago(b.packedAt)} · {units} item{units !== 1 ? "s" : ""}</Text>
                  {b.orderNames.length > 0 && <Text as="span" variant="bodySm" tone="subdued">{b.orderNames.join(", ")}</Text>}
                </BlockStack>
                <Address shipTo={b.shipTo} />
                <div style={{ fontSize: 12, color: "#555", lineHeight: 1.5 }}>
                  {b.items.map((i) => `${i.sku || i.title}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`).join(", ")}
                </div>
              </div>
            );
          })}
        </Card>
      </BlockStack>
    );
  }

  // ── Packed: full cards with reasons and undo ──
  return (
    <BlockStack gap="300">
      <Text as="p" tone="subdued" variant="bodySm">
        Packed in the last {days} days but not ready to ship yet. A bag moves to "Ready to ship" once everything's
        packed and payment and shipping are cleared.
      </Text>
      {bags.map((b) => {
        const units = b.items.reduce((n, i) => n + i.quantity, 0);
        if (b.legacy) {
          const l = b.legacy;
          return (
            <Card key={b.key}>
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <BlockStack gap="100">
                    <Text as="h3" variant="headingMd">{b.name}</Text>
                    <Text as="span" tone="subdued" variant="bodySm">
                      Packed {ago(l.packedAt)} with the earlier button · {l.purchaseIds.length} item{l.purchaseIds.length !== 1 ? "s" : ""} · parcel {l.groupKey}
                    </Text>
                    <Text as="span" tone="subdued" variant="bodySm">Purchases: {l.purchaseIds.join(", ")}</Text>
                  </BlockStack>
                  {onUndoLegacy && (
                    <Button tone="critical" loading={undoingId === `legacy:${l.groupKey}`} onClick={() => onUndoLegacy(l)}>Undo packed</Button>
                  )}
                </InlineStack>
                <SendStatus pkgs={[l]} />
              </BlockStack>
            </Card>
          );
        }
        const first = b.pkgs[b.pkgs.length - 1];
        return (
          <Card key={b.key}>
            <BlockStack gap="300">
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center">
                  <span style={{ fontFamily: "monospace", fontWeight: 800, fontSize: 14, background: "#eef2ff", color: "#1d4ed8", padding: "2px 8px", borderRadius: 4 }}>{b.code}</span>
                  <Text as="h3" variant="headingMd">{b.name}</Text>
                  {b.usernames.length > 0 && <Text as="span" variant="bodySm" tone="subdued">Trade Me: {b.usernames.join(", ")}</Text>}
                </InlineStack>
                <Text as="span" tone="subdued" variant="bodySm">
                  Packed {ago(first.packedAt)}{b.pkgs.length > 1 ? ` · added to ${b.pkgs.length - 1} time${b.pkgs.length > 2 ? "s" : ""} since` : ""} · {units} item{units !== 1 ? "s" : ""}{first.email ? ` · ${first.email}` : ""}
                </Text>
              </BlockStack>
              <SendStatus pkgs={b.pkgs} />
              {b.pkgs.map((p) => (
                <BlockStack key={p.id} gap="150">
                  <InlineStack align="space-between" blockAlign="center" wrap>
                    <InlineStack gap="200" wrap blockAlign="center">
                      <Text as="span" variant="bodySm" fontWeight="semibold">{b.pkgs.length > 1 ? (p === first ? "First packed" : "Added") : "Packed"} {ago(p.packedAt)}</Text>
                      {p.orders.map((o) => (
                        <Badge key={o.id} tone={o.sent ? "success" : "attention"}>{`${o.name} · ${o.sent ? "sent" : "not sent"}`}</Badge>
                      ))}
                      {p.tradeMeItems > 0 && <Badge tone="info">{`Trade Me · ${p.tradeMeItems} item${p.tradeMeItems !== 1 ? "s" : ""}`}</Badge>}
                    </InlineStack>
                    <Button tone="critical" size="slim" loading={undoingId === p.id} onClick={() => onUndo(p)}>Undo packed</Button>
                  </InlineStack>
                  {p.items.map((i, idx) => (
                    <InlineStack key={`${i.sku}-${idx}`} gap="300" blockAlign="center" wrap={false}>
                      <Thumb src={i.imageUrl} sku={i.sku} title={i.title} size={36} radius={5} fontSize={10} colour={GREY} />
                      <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 13, minWidth: 90 }}>{i.sku || "—"}</div>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{i.title}</div>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>×{i.quantity}</div>
                    </InlineStack>
                  ))}
                </BlockStack>
              ))}
            </BlockStack>
          </Card>
        );
      })}
    </BlockStack>
  );
}
