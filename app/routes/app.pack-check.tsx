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
  shippingTitle: string;
  shippingAmount: number;
  shippingOriginalAmount: number;
  shippingWasFree: boolean;
  hasShippingDiscount: boolean;
  currencyCode: string;
  discountCodes: string[];
  lineItems: LineItem[];
}

interface PackItem extends LineItem {
  scanned: number;
  sortKey: string;
  orderNames: string[];
}

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

export default function PackCheck() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [selectValue, setSelectValue] = useState("");
  const [packItems, setPackItems] = useState<PackItem[]>([]);
  const [scanValue, setScanValue] = useState("");
  const [scanMsg, setScanMsg] = useState<{ text: string; tone: "success" | "critical" | "warning" | "" }>({ text: "", tone: "" });
  const [filter, setFilter] = useState<"all" | "remaining" | "done">("all");
  const [history, setHistory] = useState<string[]>([]);
  const [showComplete, setShowComplete] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const autoConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTimeout(() => scanRef.current?.focus(), 300);
  }, [packItems.length]);

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
      const totalLines = customerOrders.reduce((s, o) => s + o.lineItems.length, 0);
      const orderCount = customerOrders.length;
      const orderLabel = orderCount > 1 ? `${orderCount} orders` : customerOrders[0].name;
      const totalShipping = customerOrders.reduce((s, o) => s + o.shippingAmount, 0);
      const hasIssue = totalShipping === 0 || customerOrders.some(o => o.hasShippingDiscount || o.discountCodes.length > 0);
      const issueFlag = hasIssue ? " ⚠️" : "";
      options.push({
        label: `${customer} — ${orderLabel} · ${totalLines} item${totalLines !== 1 ? "s" : ""}${issueFlag}`,
        value: customer,
      });
    }

    return options;
  };

  function selectOrder(value: string) {
    setSelectValue(value);
    setHistory([]);
    setScanMsg({ text: "", tone: "" });
    setShowComplete(false);
    setFilter("all");

    if (!value) {
      setSelectedOrderIds([]);
      setPackItems([]);
      return;
    }

    const customerOrders = orders.filter(o => o.customer === value);
    const orderIds = customerOrders.map(o => o.id);
    setSelectedOrderIds(orderIds);

    const map = new Map<string, PackItem>();
    for (const order of customerOrders) {
      for (const item of order.lineItems) {
        const sku = normaliseSku(item.sku || "");
        const key = sku || item.id;
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
            sortKey: sku ? skuSortKey(sku) : `ZZZ_${item.title}`,
            orderNames: [order.name],
          });
        }
      }
    }

    const sorted = [...map.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    setPackItems(sorted);
  }

  const selectedOrders = orders.filter(o => selectedOrderIds.includes(o.id));
  const totalShipping = selectedOrders.reduce((s, o) => s + o.shippingAmount, 0);
  const noShippingPaid = selectedOrders.length > 0 && totalShipping === 0;
  const ordersWithShippingDiscount = selectedOrders.filter(o => o.hasShippingDiscount);
  const allDiscountCodes = selectedOrders.flatMap(o =>
    o.discountCodes.map(code => ({ code, orderName: o.name }))
  );
  const hasAnyIssue = noShippingPaid || ordersWithShippingDiscount.length > 0 || allDiscountCodes.length > 0;

  function handleScanChange(value: string) {
    setScanValue(value);
    if (autoConfirmTimer.current) clearTimeout(autoConfirmTimer.current);
    if (value.trim()) {
      autoConfirmTimer.current = setTimeout(() => confirmScan(value), 300);
    }
  }

  function confirmScan(rawOverride?: string) {
    if (autoConfirmTimer.current) clearTimeout(autoConfirmTimer.current);
    const raw = (rawOverride ?? scanValue).trim();
    if (!raw) return;
    const sku = normaliseSku(raw);
    setScanValue("");

    if (!packItems.length) {
      setScanMsg({ text: "Load an order first.", tone: "warning" });
      return;
    }

    const idx = packItems.findIndex(i =>
      (i.sku && (i.sku === sku || i.sku === raw.toUpperCase())) ||
      i.title.toLowerCase() === raw.toLowerCase()
    );

    if (idx === -1) {
      setScanMsg({ text: `❌ "${sku}" not in this order!`, tone: "critical" });
      return;
    }

    setPackItems(prev => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], scanned: updated[idx].scanned + 1 };
      const item = updated[idx];
      const label = item.sku || item.title;
      if (item.scanned > item.quantity) {
        setScanMsg({ text: `⚠️ ${label} — OVER-SCANNED (${item.scanned}/${item.quantity})`, tone: "critical" });
      } else if (item.scanned === item.quantity) {
        setScanMsg({ text: `✓ ${label} complete (${item.scanned}/${item.quantity})`, tone: "success" });
        if (updated.every(i => i.scanned === i.quantity)) setTimeout(() => setShowComplete(true), 400);
      } else {
        setScanMsg({ text: `✓ ${label} (${item.scanned}/${item.quantity})`, tone: "success" });
      }
      return updated;
    });

    setHistory(h => [...h, packItems[idx].sku || packItems[idx].title]);
    setTimeout(() => scanRef.current?.focus(), 50);
  }

  function markPacked(item: PackItem) {
    const key = item.sku || item.title;
    setPackItems(prev => {
      const idx = prev.findIndex(i => (i.sku || i.title) === key);
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = { ...updated[idx], scanned: updated[idx].scanned + 1 };
      const u = updated[idx];
      if (u.scanned > u.quantity) {
        setScanMsg({ text: `⚠️ ${key} — OVER-SCANNED`, tone: "critical" });
      } else if (u.scanned === u.quantity) {
        setScanMsg({ text: `✓ ${key} complete`, tone: "success" });
        if (updated.every(i => i.scanned === i.quantity)) setTimeout(() => setShowComplete(true), 400);
      } else {
        setScanMsg({ text: `✓ ${key} (${u.scanned}/${u.quantity})`, tone: "success" });
      }
      return updated;
    });
    setHistory(h => [...h, key]);
  }

  function undoLast() {
    if (!history.length) return;
    const lastKey = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    setPackItems(prev => {
      const idx = prev.findIndex(i => (i.sku || i.title) === lastKey);
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = { ...updated[idx], scanned: Math.max(0, updated[idx].scanned - 1) };
      return updated;
    });
    setScanMsg({ text: `↩ Undid: ${lastKey}`, tone: "warning" });
    setShowComplete(false);
  }

  function resetScans() {
    setPackItems(prev => prev.map(i => ({ ...i, scanned: 0 })));
    setHistory([]);
    setScanMsg({ text: "Scans reset.", tone: "warning" });
    setShowComplete(false);
  }

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
  const nextItem = packItems.find(i => i.scanned < i.quantity);
  const nextColour = nextItem ? getPrefixColour(nextItem.sku) : PALETTE[0];

  return (
    <Page
      title="Pack Check"
      subtitle="Scan or enter SKUs to confirm packing"
      primaryAction={<Button onClick={fetchOrders} loading={loadingOrders}>Refresh Orders</Button>}
    >
      <Layout>

        {/* ── SHIPPING / DISCOUNT WARNINGS ── */}
        {hasAnyIssue && (
          <Layout.Section>
            <div style={{
              background: "#fff0f0",
              border: "3px solid #d72c0d",
              borderRadius: 10,
              padding: "20px 24px",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
                <span style={{ fontSize: 28 }}>🚨</span>
                <Text variant="headingLg" as="h2">
                  Shipping / Discount Issue — Check Before Packing
                </Text>
              </div>

              {/* No shipping paid */}
              {noShippingPaid && (
                <div style={{
                  background: "#d72c0d",
                  color: "#fff",
                  borderRadius: 8,
                  padding: "12px 16px",
                  marginBottom: 10,
                  fontWeight: 700,
                  fontSize: 15,
                }}>
                  ❌ NO SHIPPING PAID — Total shipping across all orders is $0.00
                </div>
              )}

              {/* Per-order shipping breakdown */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: allDiscountCodes.length > 0 ? 12 : 0 }}>
                {selectedOrders.map(o => {
                  const issueBg = o.shippingAmount === 0 || o.hasShippingDiscount ? "#fff3cd" : "#f0fff4";
                  const issueText = o.shippingAmount === 0 || o.hasShippingDiscount ? "#856404" : "#008060";
                  return (
                    <div key={o.id} style={{
                      background: issueBg,
                      border: `1px solid ${o.shippingAmount === 0 || o.hasShippingDiscount ? "#f0c040" : "#c3e6cb"}`,
                      borderRadius: 6,
                      padding: "10px 14px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: 8,
                    }}>
                      <div>
                        <span style={{ fontWeight: 700, marginRight: 8, color: "#333" }}>{o.name}</span>
                        <span style={{ color: "#555" }}>{o.shippingTitle}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {o.shippingOriginalAmount > 0 && o.shippingAmount === 0 && (
                          <span style={{ textDecoration: "line-through", color: "#999", fontSize: 13 }}>
                            ${o.shippingOriginalAmount.toFixed(2)}
                          </span>
                        )}
                        <span style={{ fontWeight: 700, color: issueText, fontSize: 16 }}>
                          ${o.shippingAmount.toFixed(2)} {o.currencyCode}
                        </span>
                        {o.hasShippingDiscount && (
                          <span style={{
                            background: "#f0c040", color: "#856404",
                            fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                          }}>DISCOUNT APPLIED</span>
                        )}
                        {o.shippingWasFree && !o.hasShippingDiscount && (
                          <span style={{
                            background: "#ffc107", color: "#856404",
                            fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                          }}>FREE SHIPPING SELECTED</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Discount codes */}
              {allDiscountCodes.length > 0 && (
                <div style={{
                  background: "#fff3cd",
                  border: "1px solid #f0c040",
                  borderRadius: 8,
                  padding: "12px 16px",
                }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#856404", marginBottom: 6 }}>
                    🏷️ Promotional / Discount Codes Used:
                  </div>
                  {allDiscountCodes.map((d, i) => (
                    <div key={i} style={{ fontSize: 14, color: "#856404", marginBottom: 2 }}>
                      <strong>{d.orderName}:</strong> <code style={{
                        background: "#fff",
                        padding: "1px 6px",
                        borderRadius: 4,
                        border: "1px solid #f0c040",
                        fontFamily: "monospace",
                        fontWeight: 700,
                      }}>{d.code}</code>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Layout.Section>
        )}

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

        {/* ── NEXT ITEM HERO ── */}
        {nextItem && (
          <Layout.Section>
            <Card>
              <div style={{ display: "flex", gap: 24, alignItems: "center", padding: "8px 0" }}>
                {nextItem.imageUrl ? (
                  <img src={nextItem.imageUrl} alt={nextItem.title}
                    style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 8, flexShrink: 0 }} />
                ) : (
                  <div style={{
                    width: 120, height: 120, borderRadius: 8, flexShrink: 0,
                    background: nextColour.bg, display: "flex", alignItems: "center",
                    justifyContent: "center", fontSize: 28, fontWeight: 700, color: nextColour.text,
                  }}>
                    {nextItem.sku ? nextItem.sku.substring(0, 2) : "?"}
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "#888", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.08em" }}>Next to pack</div>
                  {nextItem.sku ? (
                    <div style={{
                      display: "inline-block", background: nextColour.bg, color: nextColour.text,
                      fontFamily: "monospace", fontWeight: 700, fontSize: 28,
                      padding: "4px 14px", borderRadius: 6, marginBottom: 8,
                    }}>
                      {nextItem.sku}
                    </div>
                  ) : (
                    <div style={{ marginBottom: 8 }}>
                      <Badge tone="warning">No SKU — manual item</Badge>
                    </div>
                  )}
                  <div style={{ fontSize: 15, color: "#333", marginBottom: 8 }}>
                    {nextItem.title}
                    {nextItem.variantTitle && nextItem.variantTitle !== "Default Title" ? ` · ${nextItem.variantTitle}` : ""}
                  </div>
                  <InlineStack gap="300" blockAlign="center">
                    <div style={{ fontSize: 13, color: "#888" }}>
                      {nextItem.scanned}/{nextItem.quantity} packed
                      {nextItem.orderNames.length > 1 && ` · ${nextItem.orderNames.join(", ")}`}
                    </div>
                    <Button variant="primary" onClick={() => markPacked(nextItem)}>
                      ✓ Mark as packed
                    </Button>
                  </InlineStack>
                </div>
              </div>
            </Card>
          </Layout.Section>
        )}

        {/* ── TWO COLUMN LAYOUT ── */}
        <Layout.Section>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 16, alignItems: "start" }}>

            {/* LEFT COLUMN */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">Select Customer / Order</Text>
                  {loadingOrders ? (
                    <InlineStack align="center"><Spinner size="small" /></InlineStack>
                  ) : (
                    <Select
                      label="Unfulfilled orders — grouped by customer"
                      options={groupedOptions()}
                      value={selectValue}
                      onChange={selectOrder}
                    />
                  )}

                  {/* Shipping breakdown per order */}
                  {selectedOrders.length > 0 && (
                    <BlockStack gap="200">
                      <InlineStack gap="200" wrap>
                        <Badge tone="info">{selectedOrders[0].customer}</Badge>
                        <Badge>{totalQty} item{totalQty !== 1 ? "s" : ""}</Badge>
                        {selectedOrders.length > 1 && (
                          <Badge tone="attention">{selectedOrders.length} orders merged</Badge>
                        )}
                      </InlineStack>

                      <Divider />

                      <Text variant="bodySm" as="p" tone="subdued">Shipping per order:</Text>
                      {selectedOrders.map(o => (
                        <div key={o.id} style={{
                          display: "flex", justifyContent: "space-between", alignItems: "center",
                          padding: "6px 10px", borderRadius: 6, flexWrap: "wrap", gap: 6,
                          background: o.shippingAmount === 0 || o.hasShippingDiscount ? "#fff3cd" : "#f0fff4",
                          border: `1px solid ${o.shippingAmount === 0 || o.hasShippingDiscount ? "#f0c040" : "#c3e6cb"}`,
                        }}>
                          <div style={{ fontSize: 13 }}>
                            <span style={{ fontWeight: 700, marginRight: 6 }}>{o.name}</span>
                            <span style={{ color: "#666" }}>{o.shippingTitle}</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            {o.shippingOriginalAmount > 0 && o.shippingAmount === 0 && (
                              <span style={{ textDecoration: "line-through", color: "#999", fontSize: 12 }}>
                                ${o.shippingOriginalAmount.toFixed(2)}
                              </span>
                            )}
                            <span style={{
                              fontWeight: 700, fontSize: 14,
                              color: o.shippingAmount === 0 ? "#d72c0d" : "#008060",
                            }}>
                              ${o.shippingAmount.toFixed(2)}
                            </span>
                            {o.discountCodes.length > 0 && (
                              <span style={{
                                background: "#f0c040", color: "#856404",
                                fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 3,
                              }}>
                                {o.discountCodes.join(", ")}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}

                      <div style={{
                        display: "flex", justifyContent: "space-between",
                        padding: "8px 10px", borderRadius: 6,
                        background: totalShipping === 0 ? "#fff0f0" : "#f0fff4",
                        fontWeight: 700, fontSize: 14,
                      }}>
                        <span>Total shipping</span>
                        <span style={{ color: totalShipping === 0 ? "#d72c0d" : "#008060" }}>
                          ${totalShipping.toFixed(2)} {selectedOrders[0]?.currencyCode}
                        </span>
                      </div>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {packItems.length > 0 && (
                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingMd" as="h2">Scan / Enter SKU</Text>
                    <TextField
                      label="" labelHidden
                      value={scanValue}
                      onChange={handleScanChange}
                      onKeyDown={e => e.key === "Enter" && confirmScan()}
                      placeholder="Scan barcode or type SKU…"
                      autoComplete="off" autoCorrect="off" spellCheck={false}
                      ref={scanRef} size="large"
                    />
                    {scanMsg.text && (
                      <Box
                        background={
                          scanMsg.tone === "success" ? "bg-fill-success" :
                          scanMsg.tone === "critical" ? "bg-fill-critical" : "bg-fill-warning"
                        }
                        padding="200" borderRadius="200"
                      >
                        <Text variant="bodyMd" as="p" fontWeight="semibold">{scanMsg.text}</Text>
                      </Box>
                    )}
                  </BlockStack>
                </Card>
              )}
            </div>

            {/* RIGHT COLUMN */}
            {packItems.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
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
                          const c = getPrefixColour(item.sku);
                          const isNext = item === nextItem;

                          return (
                            <div
                              key={item.id}
                              onClick={() => { if (item.sku) { setScanValue(item.sku); scanRef.current?.focus(); } }}
                              style={{
                                display: "flex", alignItems: "center", gap: "10px",
                                padding: "10px 12px", borderRadius: "8px",
                                border: `1px solid ${over ? "#d72c0d" : isNext ? c.bg : done ? "#e3e3e3" : partial ? "#e1a900" : "#e3e3e3"}`,
                                borderLeft: `5px solid ${c.bg}`,
                                background: over ? "#fff4f4" : isNext ? `${c.bg}22` : done ? "#f8f8f8" : "#ffffff",
                                cursor: item.sku ? "pointer" : "default",
                                opacity: done ? 0.55 : 1,
                                transition: "all 0.15s",
                              }}
                            >
                              {item.imageUrl ? (
                                <img src={item.imageUrl} alt={item.title}
                                  style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 5, flexShrink: 0, opacity: done ? 0.5 : 1 }} />
                              ) : (
                                <div style={{
                                  width: 40, height: 40, borderRadius: 5, background: c.bg, flexShrink: 0,
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                  fontSize: 10, fontWeight: 700, color: c.text,
                                }}>
                                  {item.sku ? item.sku.substring(0, 2) : "?"}
                                </div>
                              )}

                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                                  {item.sku ? (
                                    <div style={{
                                      background: c.bg, color: c.text, fontFamily: "monospace",
                                      fontWeight: 700, fontSize: "13px", padding: "2px 7px",
                                      borderRadius: "4px", flexShrink: 0,
                                      textDecoration: done ? "line-through" : "none",
                                    }}>
                                      {item.sku}
                                    </div>
                                  ) : (
                                    <Badge tone="warning" size="small">No SKU</Badge>
                                  )}
                                  {item.orderNames.length > 1 && (
                                    <span style={{ fontSize: 10, color: "#888" }}>{item.orderNames.join(", ")}</span>
                                  )}
                                </div>
                                <div style={{ fontSize: 12, color: done ? "#999" : "#444", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {item.title}
                                  {item.variantTitle && item.variantTitle !== "Default Title" ? ` · ${item.variantTitle}` : ""}
                                </div>
                              </div>

                              <div style={{
                                fontFamily: "monospace", fontWeight: 700, fontSize: "15px",
                                color: over ? "#d72c0d" : done ? "#008060" : partial ? "#e1a900" : "#6d7175",
                                minWidth: "46px", textAlign: "right", flexShrink: 0,
                              }}>
                                {item.scanned}/{item.quantity}
                              </div>

                              {!done ? (
                                <div onClick={e => e.stopPropagation()}>
                                  <Button size="slim" variant="primary" onClick={() => markPacked(item)}>✓</Button>
                                </div>
                              ) : (
                                <div style={{ fontSize: "18px", width: "22px", textAlign: "center", flexShrink: 0 }}>
                                  {over ? "⚠️" : "✅"}
                                </div>
                              )}
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
              </div>
            )}
          </div>
        </Layout.Section>

        {!loadingOrders && !packItems.length && selectedOrderIds.length === 0 && (
          <Layout.Section>
            <Card>
              <EmptyState
                heading="Select a customer to start packing"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Orders are grouped by customer. Multiple orders are automatically merged. Shipping issues and discount codes are flagged prominently.</p>
              </EmptyState>
            </Card>
          </Layout.Section>
        )}

      </Layout>
    </Page>
  );
}
