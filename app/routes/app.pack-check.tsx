import { useState, useEffect, useRef, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  ButtonGroup,
  Select,
  TextField,
  Badge,
  Banner,
  ProgressBar,
  Divider,
  InlineStack,
  BlockStack,
  Box,
  EmptyState,
  Spinner,
} from "@shopify/polaris";

// ── TYPES ──────────────────────────────────────────────────────────────────
interface LineItem {
  id: string;
  title: string;
  quantity: number;
  sku: string;
  variantTitle?: string;
  imageUrl?: string | null;
}

interface Order {
  id: string;
  name: string;
  createdAt: string;
  status: string;
  customerId: string | null;
  customer: string;
  lineItems: LineItem[];
}

interface PackItem extends LineItem {
  scanned: number;
  sortKey: string;
  orderNames: string[];
}

// ── PREFIX COLOUR SYSTEM ───────────────────────────────────────────────────
const PALETTE = [
  { bg: "#d4f57a", text: "#2d4a00" },
  { bg: "#ffb3b3", text: "#5c0000" },
  { bg: "#87d4f5", text: "#003a52" },
  { bg: "#fff176", text: "#4a3800" },
  { bg: "#f9c8e3", text: "#5c0030" },
  { bg: "#ffcc99", text: "#5c2800" },
];

function getPrefixColour(sku: string) {
  if (!sku || sku.length < 2) return PALETTE[0];
  const prefix = sku.substring(0, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(prefix)) return { bg: "#e0e0e0", text: "#444" };
  const idx = (prefix.charCodeAt(0) - 65) * 26 + (prefix.charCodeAt(1) - 65);
  return PALETTE[idx % PALETTE.length];
}

function normaliseSku(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, "");
  const m = s.match(/^([A-Z]{2})-?(\d{1,3})$/);
  if (!m) return s;
  return m[1] + "-" + m[2].padStart(3, "0");
}

function skuSortKey(sku: string): string {
  const m = sku.match(/^([A-Z]{2})-(\d+)$/);
  if (!m) return sku;
  return m[1] + m[2].padStart(6, "0");
}

// ── COMPONENT ─────────────────────────────────────────────────────────────
export default function PackCheck() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [packItems, setPackItems] = useState<PackItem[]>([]);
  const [scanValue, setScanValue] = useState("");
  const [scanMsg, setScanMsg] = useState<{ text: string; tone: "success" | "critical" | "warning" | "" }>({ text: "", tone: "" });
  const [filter, setFilter] = useState<"all" | "remaining" | "done">("all");
  const [history, setHistory] = useState<string[]>([]);
  const [showComplete, setShowComplete] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => scanRef.current?.focus(), 300);
  }, [packItems.length]);

  // ── LOAD ORDERS ──────────────────────────────────────────────────────────
  const fetchOrders = useCallback(async () => {
    setLoadingOrders(true);
    try {
      const res = await fetch("/api/orders");
      const data = await res.json();
      setOrders(data.orders ?? []);
    } catch (e) {
      console.error("Failed to fetch orders", e);
    } finally {
      setLoadingOrders(false);
    }
  }, []);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  // ── GROUP OPTIONS — one entry per customer, auto-merged ───────────────────
  const groupedOptions = () => {
    const groups = new Map<string, Order[]>();
    for (const order of orders) {
      const key = order.customer;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(order);
    }

    const options: { label: string; value: string }[] = [
      { label: "— Select an order —", value: "" },
    ];

    const sorted = [...groups.entries()].sort((a, b) => {
      const aDate = Math.max(...a[1].map(o => new Date(o.createdAt).getTime()));
      const bDate = Math.max(...b[1].map(o => new Date(o.createdAt).getTime()));
      return bDate - aDate;
    });

    for (const [customer, customerOrders] of sorted) {
      const allIds = customerOrders.map(o => o.id).join(",");
      const totalLines = customerOrders.reduce((s, o) => s + o.lineItems.length, 0);
      const orderNames = customerOrders.map(o => o.name).join(", ");
      const mergeNote = customerOrders.length > 1 ? ` — ${customerOrders.length} orders merged` : "";
      options.push({
        label: `${orderNames} · ${customer} · ${totalLines} line${totalLines !== 1 ? "s" : ""}${mergeNote}`,
        value: `MERGE:${allIds}`,
      });
    }

    return options;
  };

  // ── SELECT ORDER ─────────────────────────────────────────────────────────
  function selectOrder(value: string) {
    setHistory([]);
    setScanMsg({ text: "", tone: "" });
    setShowComplete(false);
    setFilter("all");

    if (!value) {
      setSelectedOrderIds([]);
      setPackItems([]);
      return;
    }

    const orderIds = value.replace("MERGE:", "").split(",");
    setSelectedOrderIds(orderIds);

    const selectedOrders = orders.filter(o => orderIds.includes(o.id));
    const map = new Map<string, PackItem>();

    for (const order of selectedOrders) {
      for (const item of order.lineItems) {
        const sku = normaliseSku(item.sku || "");
        const key = sku || item.title;
        if (map.has(key)) {
          map.get(key)!.quantity += item.quantity;
          if (!map.get(key)!.orderNames.includes(order.name)) {
            map.get(key)!.orderNames.push(order.name);
          }
        } else {
          map.set(key, {
            ...item,
            sku,
            scanned: 0,
            sortKey: skuSortKey(sku),
            orderNames: [order.name],
          });
        }
      }
    }

    const sorted = [...map.values()].sort((a, b) =>
      a.sortKey.localeCompare(b.sortKey)
    );
    setPackItems(sorted);
  }

  // ── SCAN ─────────────────────────────────────────────────────────────────
  function confirmScan() {
    const raw = scanValue.trim();
    if (!raw) return;
    const sku = normaliseSku(raw);
    setScanValue("");

    if (!packItems.length) {
      setScanMsg({ text: "Load an order first.", tone: "warning" });
      return;
    }

    const idx = packItems.findIndex(i =>
      i.sku === sku || i.sku === raw.toUpperCase() || i.title.toLowerCase() === raw.toLowerCase()
    );

    if (idx === -1) {
      setScanMsg({ text: `❌ "${sku}" not in this order!`, tone: "critical" });
      return;
    }

    setPackItems(prev => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], scanned: updated[idx].scanned + 1 };
      const item = updated[idx];
      if (item.scanned > item.quantity) {
        setScanMsg({ text: `⚠️ ${sku} — OVER-SCANNED (${item.scanned}/${item.quantity})`, tone: "critical" });
      } else if (item.scanned === item.quantity) {
        setScanMsg({ text: `✓ ${sku} complete (${item.scanned}/${item.quantity})`, tone: "success" });
        const allDone = updated.every(i => i.scanned === i.quantity);
        if (allDone) setTimeout(() => setShowComplete(true), 400);
      } else {
        setScanMsg({ text: `✓ ${sku} (${item.scanned}/${item.quantity})`, tone: "success" });
      }
      return updated;
    });

    setHistory(h => [...h, sku]);
  }

  function undoLast() {
    if (!history.length) return;
    const lastSku = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    setPackItems(prev => {
      const idx = prev.findIndex(i => i.sku === lastSku);
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = { ...updated[idx], scanned: Math.max(0, updated[idx].scanned - 1) };
      return updated;
    });
    setScanMsg({ text: `↩ Undid: ${lastSku}`, tone: "warning" });
    setShowComplete(false);
  }

  function resetScans() {
    setPackItems(prev => prev.map(i => ({ ...i, scanned: 0 })));
    setHistory([]);
    setScanMsg({ text: "Scans reset.", tone: "warning" });
    setShowComplete(false);
  }

  // ── PROGRESS ─────────────────────────────────────────────────────────────
  const totalQty = packItems.reduce((s, i) => s + i.quantity, 0);
  const scannedQty = packItems.reduce((s, i) => s + Math.min(i.scanned, i.quantity), 0);
  const progressPct = totalQty ? Math.round((scannedQty / totalQty) * 100) : 0;
  const hasOverScan = packItems.some(i => i.scanned > i.quantity);

  const filteredItems = packItems.filter(item => {
    const done = item.scanned >= item.quantity;
    if (filter === "remaining") return !done;
    if (filter === "done") return done;
    return true;
  });

  const selectedOrders = orders.filter(o => selectedOrderIds.includes(o.id));

  return (
    <Page
      title="Pack Check"
      subtitle="Scan or enter SKUs to confirm packing"
      primaryAction={
        <Button onClick={fetchOrders} loading={loadingOrders}>Refresh Orders</Button>
      }
    >
      <Layout>

        {/* ── ORDER SELECTOR ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Select Customer / Order</Text>
              {loadingOrders ? (
                <InlineStack align="center"><Spinner size="small" /></InlineStack>
              ) : (
                <Select
                  label="Unfulfilled orders — grouped by customer"
                  options={groupedOptions()}
                  value={selectedOrderIds.length > 0 ? `MERGE:${selectedOrderIds.join(",")}` : ""}
                  onChange={selectOrder}
                />
              )}
              {selectedOrders.length > 0 && (
                <InlineStack gap="200" wrap>
                  {selectedOrders.map(o => (
                    <Badge key={o.id} tone="info">{o.name}</Badge>
                  ))}
                  <Badge>{selectedOrders[0].customer}</Badge>
                  <Badge>{totalQty} item{totalQty !== 1 ? "s" : ""}</Badge>
                  {selectedOrders.length > 1 && (
                    <Badge tone="attention">{selectedOrders.length} orders merged</Badge>
                  )}
                </InlineStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {packItems.length > 0 && (
          <>
            {showComplete && (
              <Layout.Section>
                <Banner title="✅ All items packed!" tone="success" onDismiss={() => setShowComplete(false)}>
                  <p>{packItems.length} SKUs · {totalQty} items — all confirmed. Ready to ship.</p>
                </Banner>
              </Layout.Section>
            )}

            {hasOverScan && (
              <Layout.Section>
                <Banner title="Over-scan detected" tone="critical">
                  <p>One or more items scanned more than ordered.</p>
                </Banner>
              </Layout.Section>
            )}

            {/* ── SCAN INPUT ── */}
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text variant="headingMd" as="h2">Scan / Enter SKU</Text>
                  <InlineStack gap="200" align="start" blockAlign="end">
                    <div style={{ flex: 1 }}>
                      <TextField
                        label=""
                        labelHidden
                        value={scanValue}
                        onChange={setScanValue}
                        onKeyDown={e => e.key === "Enter" && confirmScan()}
                        placeholder="Scan barcode or type SKU…"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        ref={scanRef}
                        size="large"
                      />
                    </div>
                    <Button variant="primary" onClick={confirmScan} size="large">Confirm ✓</Button>
                  </InlineStack>
                  {scanMsg.text && (
                    <Box
                      background={
                        scanMsg.tone === "success" ? "bg-fill-success" :
                        scanMsg.tone === "critical" ? "bg-fill-critical" :
                        "bg-fill-warning"
                      }
                      padding="200"
                      borderRadius="200"
                    >
                      <Text variant="bodyMd" as="p" fontWeight="semibold">{scanMsg.text}</Text>
                    </Box>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>

            {/* ── PROGRESS ── */}
            <Layout.Section>
              <Card>
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text variant="bodyMd" as="p" tone="subdued">{scannedQty} / {totalQty} items confirmed</Text>
                    <Text variant="bodyMd" as="p" fontWeight="bold">{progressPct}%</Text>
                  </InlineStack>
                  <ProgressBar
                    progress={progressPct}
                    tone={hasOverScan ? "critical" : progressPct === 100 ? "success" : "highlight"}
                    size="medium"
                  />
                </BlockStack>
              </Card>
            </Layout.Section>

            {/* ── PICK LIST ── */}
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="headingMd" as="h2">Pick List</Text>
                    <ButtonGroup>
                      <Button variant={filter === "all" ? "primary" : "secondary"} onClick={() => setFilter("all")} size="slim">All</Button>
                      <Button variant={filter === "remaining" ? "primary" : "secondary"} onClick={() => setFilter("remaining")} size="slim">Remaining</Button>
                      <Button variant={filter === "done" ? "primary" : "secondary"} onClick={() => setFilter("done")} size="slim">Done</Button>
                    </ButtonGroup>
                  </InlineStack>

                  <Divider />

                  <BlockStack gap="200">
                    {filteredItems.length === 0 ? (
                      <Box padding="400">
                        <Text as="p" tone="subdued" alignment="center">
                          {filter === "remaining" ? "🎉 All items packed!" : "No items in this view."}
                        </Text>
                      </Box>
                    ) : (
                      filteredItems.map(item => {
                        const done = item.scanned >= item.quantity;
                        const over = item.scanned > item.quantity;
                        const partial = item.scanned > 0 && item.scanned < item.quantity;
                        const colour = getPrefixColour(item.sku);

                        return (
                          <div
                            key={item.id}
                            onClick={() => { setScanValue(item.sku); scanRef.current?.focus(); }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "12px",
                              padding: "10px 14px",
                              borderRadius: "8px",
                              border: `1px solid ${over ? "#d72c0d" : done ? "#e3e3e3" : partial ? "#e1a900" : "#e3e3e3"}`,
                              borderLeft: `5px solid ${colour.bg}`,
                              background: over ? "#fff4f4" : done ? "#f8f8f8" : "#ffffff",
                              cursor: "pointer",
                              opacity: done ? 0.65 : 1,
                              transition: "all 0.15s",
                            }}
                          >
                            {/* Image */}
                            {item.imageUrl ? (
                              <img
                                src={item.imageUrl}
                                alt={item.title}
                                style={{
                                  width: 48,
                                  height: 48,
                                  objectFit: "cover",
                                  borderRadius: 6,
                                  flexShrink: 0,
                                  opacity: done ? 0.5 : 1,
                                }}
                              />
                            ) : (
                              <div style={{
                                width: 48,
                                height: 48,
                                borderRadius: 6,
                                background: colour.bg,
                                flexShrink: 0,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: 11,
                                fontWeight: 700,
                                color: colour.text,
                              }}>
                                {item.sku.substring(0, 2)}
                              </div>
                            )}

                            {/* SKU + title */}
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                                <div style={{
                                  background: colour.bg,
                                  color: colour.text,
                                  fontFamily: "monospace",
                                  fontWeight: 700,
                                  fontSize: "14px",
                                  padding: "2px 8px",
                                  borderRadius: "4px",
                                  flexShrink: 0,
                                  textDecoration: done ? "line-through" : "none",
                                }}>
                                  {item.sku || "—"}
                                </div>
                                {item.orderNames.length > 1 && (
                                  <span style={{ fontSize: 11, color: "#888", flexShrink: 0 }}>
                                    {item.orderNames.join(", ")}
                                  </span>
                                )}
                              </div>
                              <div style={{
                                fontSize: 13,
                                color: done ? "#999" : "#333",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}>
                                {item.title}
                                {item.variantTitle && item.variantTitle !== "Default Title" ? ` · ${item.variantTitle}` : ""}
                              </div>
                            </div>

                            {/* Counter */}
                            <div style={{
                              fontFamily: "monospace",
                              fontWeight: 700,
                              fontSize: "16px",
                              color: over ? "#d72c0d" : done ? "#008060" : partial ? "#e1a900" : "#6d7175",
                              minWidth: "52px",
                              textAlign: "right",
                              flexShrink: 0,
                            }}>
                              {item.scanned}/{item.quantity}
                            </div>

                            {/* Tick */}
                            <div style={{ fontSize: "20px", width: "24px", textAlign: "center", flexShrink: 0 }}>
                              {over ? "⚠️" : done ? "✅" : partial ? "◑" : "○"}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </BlockStack>

                  <Divider />

                  <InlineStack gap="200">
                    <Button onClick={undoLast} disabled={!history.length} tone="critical" variant="plain">↩ Undo Last</Button>
                    <Button onClick={resetScans} tone="critical" variant="plain">Reset All Scans</Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Layout.Section>
          </>
        )}

        {!loadingOrders && !packItems.length && selectedOrderIds.length === 0 && (
          <Layout.Section>
            <Card>
              <EmptyState
                heading="Select a customer to start packing"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Orders are grouped by customer. Multiple orders from the same customer are automatically merged into one pick list.</p>
              </EmptyState>
            </Card>
          </Layout.Section>
        )}

      </Layout>
    </Page>
  );
}
