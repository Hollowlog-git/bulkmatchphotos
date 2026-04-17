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
  Thumbnail,
  EmptyState,
  Spinner,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

// ── TYPES ──────────────────────────────────────────────────────────────────
interface LineItem {
  id: string;
  title: string;
  quantity: number;
  sku: string;
  variantTitle?: string;
  imageUrl?: string;
}

interface Order {
  id: string;
  name: string;
  createdAt: string;
  status: string;
  customer: string;
  lineItems: LineItem[];
}

interface PackItem extends LineItem {
  scanned: number;
  sortKey: string;
}

// ── PREFIX COLOUR SYSTEM ───────────────────────────────────────────────────
const PALETTE = [
  { bg: "#d4f57a", text: "#2d4a00", label: "Lime" },     // AA, AG...
  { bg: "#ffb3b3", text: "#5c0000", label: "Red" },       // AB, AH...
  { bg: "#87d4f5", text: "#003a52", label: "Sky Blue" },  // AC, AI...
  { bg: "#fff176", text: "#4a3800", label: "Yellow" },    // AD, AJ...
  { bg: "#f9c8e3", text: "#5c0030", label: "Pink" },      // AE, AK...
  { bg: "#ffcc99", text: "#5c2800", label: "Orange" },    // AF, AL...
];

function getPrefixColour(sku: string) {
  if (!sku || sku.length < 2) return PALETTE[0];
  const prefix = sku.substring(0, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(prefix)) return { bg: "#e0e0e0", text: "#444", label: "?" };
  const idx = (prefix.charCodeAt(0) - 65) * 26 + (prefix.charCodeAt(1) - 65);
  return PALETTE[idx % PALETTE.length];
}

function normaliseSku(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, "");
  const m = s.match(/^([A-Z]{2})-?(\d{1,3})$/);
  if (!m) return s; // return as-is if doesn't match pattern
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
  const [selectedOrderId, setSelectedOrderId] = useState<string>("");
  const [packItems, setPackItems] = useState<PackItem[]>([]);
  const [scanValue, setScanValue] = useState("");
  const [scanMsg, setScanMsg] = useState<{ text: string; tone: "success" | "critical" | "warning" | "" }>({ text: "", tone: "" });
  const [filter, setFilter] = useState<"all" | "remaining" | "done">("all");
  const [history, setHistory] = useState<string[]>([]);
  const [showComplete, setShowComplete] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  // Focus scan input on mount
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

  // ── SELECT ORDER ─────────────────────────────────────────────────────────
  function selectOrder(orderId: string) {
    setSelectedOrderId(orderId);
    setHistory([]);
    setScanMsg({ text: "", tone: "" });
    setShowComplete(false);
    setFilter("all");

    if (!orderId) { setPackItems([]); return; }

    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    // Merge duplicate SKUs, sort
    const map = new Map<string, PackItem>();
    for (const item of order.lineItems) {
      const sku = normaliseSku(item.sku || "");
      const key = sku || item.title;
      if (map.has(key)) {
        map.get(key)!.quantity += item.quantity;
      } else {
        map.set(key, {
          ...item,
          sku,
          scanned: 0,
          sortKey: skuSortKey(sku),
        });
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
        // Check if all done
        const allDone = updated.every(i => i.scanned === i.quantity);
        if (allDone) setTimeout(() => setShowComplete(true), 400);
      } else {
        setScanMsg({ text: `✓ ${sku} (${item.scanned}/${item.quantity})`, tone: "success" });
      }

      return updated;
    });

    setHistory(h => [...h, sku]);
  }

  // ── UNDO ─────────────────────────────────────────────────────────────────
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

  // ── FILTERED LIST ─────────────────────────────────────────────────────────
  const filteredItems = packItems.filter(item => {
    const done = item.scanned >= item.quantity;
    if (filter === "remaining") return !done;
    if (filter === "done") return done;
    return true;
  });

  // ── ORDER SELECT OPTIONS ──────────────────────────────────────────────────
  const orderOptions = [
    { label: "— Select an order —", value: "" },
    ...orders.map(o => ({
      label: `${o.name} · ${o.customer} · ${o.lineItems.length} line${o.lineItems.length !== 1 ? "s" : ""}`,
      value: o.id,
    })),
  ];

  const selectedOrder = orders.find(o => o.id === selectedOrderId);

  return (
    <Page
      title="Pack Check"
      subtitle="Scan or enter SKUs to confirm packing"
      primaryAction={
        <Button onClick={fetchOrders} loading={loadingOrders}>
          Refresh Orders
        </Button>
      }
    >
      <Layout>

        {/* ── ORDER SELECTOR ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Select Order</Text>
              {loadingOrders ? (
                <InlineStack align="center"><Spinner size="small" /></InlineStack>
              ) : (
                <Select
                  label="Unfulfilled orders"
                  options={orderOptions}
                  value={selectedOrderId}
                  onChange={selectOrder}
                  disabled={loadingOrders}
                />
              )}
              {selectedOrder && (
                <InlineStack gap="200" align="start">
                  <Badge tone="info">{selectedOrder.name}</Badge>
                  <Badge>{selectedOrder.customer}</Badge>
                  <Badge tone="attention">{selectedOrder.status}</Badge>
                  <Badge>{totalQty} item{totalQty !== 1 ? "s" : ""}</Badge>
                </InlineStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {packItems.length > 0 && (
          <>
            {/* ── COMPLETE BANNER ── */}
            {showComplete && (
              <Layout.Section>
                <Banner
                  title="✅ All items packed!"
                  tone="success"
                  onDismiss={() => setShowComplete(false)}
                >
                  <p>{packItems.length} SKUs · {totalQty} items — all confirmed. Ready to ship.</p>
                </Banner>
              </Layout.Section>
            )}

            {/* ── OVER-SCAN WARNING ── */}
            {hasOverScan && (
              <Layout.Section>
                <Banner title="Over-scan detected" tone="critical">
                  <p>One or more items have been scanned more times than ordered. Check highlighted items below.</p>
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
                    <Button variant="primary" onClick={confirmScan} size="large">
                      Confirm ✓
                    </Button>
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
                      <Text variant="bodyMd" as="p" fontWeight="semibold">
                        {scanMsg.text}
                      </Text>
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
                    <Text variant="bodyMd" as="p" tone="subdued">
                      {scannedQty} / {totalQty} items confirmed
                    </Text>
                    <Text variant="bodyMd" as="p" fontWeight="bold">
                      {progressPct}%
                    </Text>
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
                      <Button
                        variant={filter === "all" ? "primary" : "secondary"}
                        onClick={() => setFilter("all")}
                        size="slim"
                      >All</Button>
                      <Button
                        variant={filter === "remaining" ? "primary" : "secondary"}
                        onClick={() => setFilter("remaining")}
                        size="slim"
                      >Remaining</Button>
                      <Button
                        variant={filter === "done" ? "primary" : "secondary"}
                        onClick={() => setFilter("done")}
                        size="slim"
                      >Done</Button>
                    </ButtonGroup>
                  </InlineStack>

                  <Divider />

                  {/* LIST ITEMS */}
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
                            {/* Colour chip + SKU */}
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <InlineStack gap="200" blockAlign="center">
                                <div style={{
                                  background: colour.bg,
                                  color: colour.text,
                                  fontFamily: "monospace",
                                  fontWeight: 700,
                                  fontSize: "15px",
                                  padding: "3px 10px",
                                  borderRadius: "4px",
                                  letterSpacing: "0.04em",
                                  flexShrink: 0,
                                  textDecoration: done ? "line-through" : "none",
                                }}>
                                  {item.sku || "—"}
                                </div>
                                <Text
                                  variant="bodyMd"
                                  as="span"
                                  tone={done ? "subdued" : undefined}
                                  truncate
                                >
                                  {item.title}
                                  {item.variantTitle && item.variantTitle !== "Default Title"
                                    ? ` · ${item.variantTitle}` : ""}
                                </Text>
                              </InlineStack>
                            </div>

                            {/* Thumbnail */}
                            {item.imageUrl && (
                              <Thumbnail
                                source={item.imageUrl}
                                alt={item.title}
                                size="small"
                              />
                            )}

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

                  {/* ACTIONS */}
                  <InlineStack gap="200">
                    <Button
                      onClick={undoLast}
                      disabled={!history.length}
                      tone="critical"
                      variant="plain"
                    >
                      ↩ Undo Last
                    </Button>
                    <Button
                      onClick={resetScans}
                      tone="critical"
                      variant="plain"
                    >
                      Reset All Scans
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Layout.Section>
          </>
        )}

        {/* ── EMPTY STATE ── */}
        {!loadingOrders && !packItems.length && selectedOrderId === "" && (
          <Layout.Section>
            <Card>
              <EmptyState
                heading="Select an order to start packing"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Choose an unfulfilled order from the dropdown above. SKUs will be sorted and colour-coded by prefix for easy picking.</p>
              </EmptyState>
            </Card>
          </Layout.Section>
        )}

      </Layout>
    </Page>
  );
}
