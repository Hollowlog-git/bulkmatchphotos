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
  unitPrice: number;
  originalUnitPrice: number;
  currencyCode: string;
}

interface ShippingAddress {
  name: string;
  address1: string;
  address2: string;
  city: string;
  province: string;
  zip: string;
  country: string;
}

interface Order {
  id: string;
  name: string;
  createdAt: string;
  status: string;
  customerId: string | null;
  customer: string;
  customerEmail: string | null;
  shippingTitle: string;
  shippingAmount: number;
  shippingOriginalAmount: number;
  shippingWasFree: boolean;
  hasShippingDiscount: boolean;
  currencyCode: string;
  discountCodes: string[];
  shippingAddress: ShippingAddress | null;
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

function fmt(amount: number, currency: string) {
  return `$${amount.toFixed(2)} ${currency}`;
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
  const packItemsRef = useRef<PackItem[]>([]);
  const ordersRef = useRef<Order[]>([]);
  const selectValueRef = useRef<string>("");

  useEffect(() => { packItemsRef.current = packItems; }, [packItems]);
  useEffect(() => { ordersRef.current = orders; }, [orders]);
  useEffect(() => { selectValueRef.current = selectValue; }, [selectValue]);

  useEffect(() => {
    setTimeout(() => scanRef.current?.focus(), 300);
  }, [packItems.length]);

  const fetchOrders = useCallback(async () => {
    setLoadingOrders(true);
    try {
      const res = await fetch("/api/orders");
      const data = await res.json();
      const fetched: Order[] = data.orders ?? [];
      setOrders(fetched);
      ordersRef.current = fetched;

      if (fetched.length > 0) {
        const groups = new Map<string, Order[]>();
        for (const order of fetched) {
          if (!groups.has(order.customer)) groups.set(order.customer, []);
          groups.get(order.customer)!.push(order);
        }
        let latestCustomer = "";
        let latestDate = 0;
        for (const [customer, customerOrders] of groups.entries()) {
          const maxDate = Math.max(...customerOrders.map(o => new Date(o.createdAt).getTime()));
          if (maxDate > latestDate) { latestDate = maxDate; latestCustomer = customer; }
        }
        if (latestCustomer) selectOrderByCustomer(latestCustomer, fetched);
      }
    } catch (e) {
      console.error("Failed to fetch orders", e);
    } finally {
      setLoadingOrders(false);
    }
  }, []);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  function moveToNextOrder() {
    const allOrders = ordersRef.current;
    const currentCustomer = selectValueRef.current;
    if (!allOrders.length) return;

    const groups = new Map<string, Order[]>();
    for (const order of allOrders) {
      if (!groups.has(order.customer)) groups.set(order.customer, []);
      groups.get(order.customer)!.push(order);
    }
    const sorted = [...groups.entries()].sort((a, b) => {
      const aDate = Math.max(...a[1].map(o => new Date(o.createdAt).getTime()));
      const bDate = Math.max(...b[1].map(o => new Date(o.createdAt).getTime()));
      return bDate - aDate;
    });

    const customers = sorted.map(([c]) => c);
    const currentIdx = customers.indexOf(currentCustomer);
    const nextIdx = currentIdx + 1;

    if (nextIdx < customers.length) {
      selectOrderByCustomer(customers[nextIdx], allOrders);
      setScanMsg({ text: `→ Moved to ${customers[nextIdx]}`, tone: "success" });
    } else {
      setScanMsg({ text: "No more orders!", tone: "warning" });
    }
  }

  function selectOrderByCustomer(customer: string, orderList: Order[]) {
    setSelectValue(customer);
    selectValueRef.current = customer;
    setHistory([]);
    setScanMsg({ text: "", tone: "" });
    setShowComplete(false);
    setFilter("all");

    const customerOrders = orderList.filter(o => o.customer === customer);
    setSelectedOrderIds(customerOrders.map(o => o.id));

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
          map.set(key, { ...item, sku, scanned: 0, sortKey: sku ? skuSortKey(sku) : `ZZZ_${item.title}`, orderNames: [order.name] });
        }
      }
    }

    const sorted = [...map.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    setPackItems(sorted);
    packItemsRef.current = sorted;

    setTimeout(() => {
      (document.activeElement as HTMLElement)?.blur();
      scanRef.current?.focus();
    }, 200);
  }

  function selectOrder(value: string) {
    if (!value) {
      setSelectValue("");
      setSelectedOrderIds([]);
      setPackItems([]);
      packItemsRef.current = [];
      return;
    }
    selectOrderByCustomer(value, ordersRef.current);
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON";
      const scanFocused = document.activeElement === scanRef.current;

      if (e.key === "j" || e.key === "J") {
        if (isInput && !scanFocused) return;
        e.preventDefault();
        const next = packItemsRef.current.find(i => i.scanned < i.quantity);
        if (next) markPackedDirect(next);
        return;
      }
      if (e.key === "k" || e.key === "K") {
        if (isInput && !scanFocused) return;
        e.preventDefault();
        undoLastDirect();
        return;
      }
      if (e.key === " ") {
        if (isInput) return;
        e.preventDefault();
        moveToNextOrder();
        return;
      }

      if (isInput) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length > 1 && e.key !== "Backspace") return;
      if (packItemsRef.current.length === 0) return;

      e.preventDefault();
      scanRef.current?.focus();

      if (e.key === "Backspace") {
        setScanValue(prev => prev.slice(0, -1));
        if (autoConfirmTimer.current) clearTimeout(autoConfirmTimer.current);
        return;
      }
      if (e.key.length === 1) {
        setScanValue(prev => {
          const next = prev + e.key;
          if (autoConfirmTimer.current) clearTimeout(autoConfirmTimer.current);
          autoConfirmTimer.current = setTimeout(() => confirmScanDirect(next), 300);
          return next;
        });
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  const selectedOrders = orders.filter(o => selectedOrderIds.includes(o.id));
  const totalShipping = selectedOrders.reduce((s, o) => s + o.shippingAmount, 0);
  const noShippingPaid = selectedOrders.length > 0 && totalShipping === 0;
  const allDiscountCodes = selectedOrders.flatMap(o => o.discountCodes.map(code => ({ code, orderName: o.name })));
  const hasAnyIssue = noShippingPaid || allDiscountCodes.length > 0;
  const shippingAddress = selectedOrders[0]?.shippingAddress ?? null;
  const currencyCode = selectedOrders[0]?.currencyCode ?? "NZD";
  const customerEmail = selectedOrders[0]?.customerEmail ?? null;

  function handleScanChange(value: string) {
    setScanValue(value);
    if (autoConfirmTimer.current) clearTimeout(autoConfirmTimer.current);
    if (value.trim()) autoConfirmTimer.current = setTimeout(() => confirmScanDirect(value), 300);
  }

  function confirmScanDirect(raw: string) {
    if (autoConfirmTimer.current) clearTimeout(autoConfirmTimer.current);
    raw = raw.trim();
    if (!raw) return;
    const sku = normaliseSku(raw);
    setScanValue("");

    const items = packItemsRef.current;
    if (!items.length) { setScanMsg({ text: "Load an order first.", tone: "warning" }); return; }

    const idx = items.findIndex(i =>
      (i.sku && (i.sku === sku || i.sku === raw.toUpperCase())) ||
      i.title.toLowerCase() === raw.toLowerCase()
    );

    if (idx === -1) { setScanMsg({ text: `❌ "${sku}" not in this order!`, tone: "critical" }); return; }

    setPackItems(prev => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], scanned: updated[idx].scanned + 1 };
      const item = updated[idx];
      const label = item.sku || item.title;
      if (item.scanned > item.quantity) {
        setScanMsg({ text: `⚠️ ${label} — OVER-SCANNED (${item.scanned}/${item.quantity})`, tone: "critical" });
      } else if (item.scanned === item.quantity) {
        setScanMsg({ text: `✓ ${label} complete`, tone: "success" });
        if (updated.every(i => i.scanned === i.quantity)) setTimeout(() => setShowComplete(true), 400);
      } else {
        setScanMsg({ text: `✓ ${label} (${item.scanned}/${item.quantity})`, tone: "success" });
      }
      packItemsRef.current = updated;
      return updated;
    });

    setHistory(h => [...h, items[idx].sku || items[idx].title]);
    setTimeout(() => scanRef.current?.focus(), 50);
  }

  function confirmScan(rawOverride?: string) { confirmScanDirect(rawOverride ?? scanValue); }

  function markPackedDirect(item: PackItem) {
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
      packItemsRef.current = updated;
      return updated;
    });
    setHistory(h => [...h, key]);
  }

  function markPacked(item: PackItem) { markPackedDirect(item); }

  function undoLastDirect() {
    if (!history.length) return;
    const lastKey = history[history.length - 1];
    setHistory(prev => prev.slice(0, -1));
    setPackItems(prev => {
      const idx = prev.findIndex(i => (i.sku || i.title) === lastKey);
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = { ...updated[idx], scanned: Math.max(0, updated[idx].scanned - 1) };
      packItemsRef.current = updated;
      return updated;
    });
    setScanMsg({ text: `↩ Undid: ${lastKey}`, tone: "warning" });
    setShowComplete(false);
  }

  function undoLast() { undoLastDirect(); }

  function resetScans() {
    const reset = packItems.map(i => ({ ...i, scanned: 0 }));
    setPackItems(reset);
    packItemsRef.current = reset;
    setHistory([]);
    setScanMsg({ text: "Scans reset.", tone: "warning" });
    setShowComplete(false);
  }

  const totalQty = packItems.reduce((s, i) => s + i.quantity, 0);
  const scannedQty = packItems.reduce((s, i) => s + Math.min(i.scanned, i.quantity), 0);
  const progressPct = totalQty ? Math.round((scannedQty / totalQty) * 100) : 0;
  const hasOverScan = packItems.some(i => i.scanned > i.quantity);
  const allPacked = packItems.length > 0 && packItems.every(i => i.scanned >= i.quantity) && !hasOverScan;
  const mostValuable = packItems.length > 0
    ? [...packItems].sort((a, b) => (b.unitPrice * b.quantity) - (a.unitPrice * a.quantity))[0]
    : null;

  const filteredItems = packItems.filter(item => {
    const done = item.scanned >= item.quantity;
    if (filter === "remaining") return !done;
    if (filter === "done") return done;
    return true;
  });
  const nextItem = packItems.find(i => i.scanned < i.quantity);
  const nextColour = nextItem ? getPrefixColour(nextItem.sku) : PALETTE[0];

  const groupedOptions = () => {
    const groups = new Map<string, Order[]>();
    for (const order of orders) {
      if (!groups.has(order.customer)) groups.set(order.customer, []);
      groups.get(order.customer)!.push(order);
    }
    const options: { label: string; value: string }[] = [{ label: "— Select an order —", value: "" }];
    const sorted = [...groups.entries()].sort((a, b) => {
      const aDate = Math.max(...a[1].map(o => new Date(o.createdAt).getTime()));
      const bDate = Math.max(...b[1].map(o => new Date(o.createdAt).getTime()));
      return bDate - aDate;
    });
    for (const [customer, customerOrders] of sorted) {
      const totalLines = customerOrders.reduce((s, o) => s + o.lineItems.length, 0);
      const orderCount = customerOrders.length;
      const orderLabel = orderCount > 1 ? `${orderCount} orders` : customerOrders[0].name;
      const totalS = customerOrders.reduce((s, o) => s + o.shippingAmount, 0);
      const hasIssue = totalS === 0 || customerOrders.some(o => o.discountCodes.length > 0);
      options.push({
        label: `${customer} — ${orderLabel} · ${totalLines} item${totalLines !== 1 ? "s" : ""}${hasIssue ? " ⚠️" : ""}`,
        value: customer,
      });
    }
    return options;
  };

  return (
    <Page
      title="Pack Check"
      subtitle="J = mark packed · K = undo · Space = next order"
      primaryAction={<Button onClick={fetchOrders} loading={loadingOrders}>Refresh Orders</Button>}
    >
      <Layout>

        {/* ── WARNINGS ── */}
        {hasAnyIssue && (
          <Layout.Section>
            <div style={{ background: "#fff0f0", border: "3px solid #d72c0d", borderRadius: 10, padding: "20px 24px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                <span style={{ fontSize: 28 }}>🚨</span>
                <Text variant="headingLg" as="h2">Shipping / Discount Issue — Check Before Packing</Text>
              </div>
              {noShippingPaid && (
                <div style={{ background: "#d72c0d", color: "#fff", borderRadius: 8, padding: "12px 16px", marginBottom: 8, fontWeight: 700, fontSize: 15 }}>
                  ❌ NO SHIPPING PAID — Total shipping is $0.00
                </div>
              )}
              {allDiscountCodes.length > 0 && (
                <div style={{ background: "#fff3cd", border: "1px solid #f0c040", borderRadius: 8, padding: "12px 16px" }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#856404", marginBottom: 6 }}>🏷️ Discount Codes Used:</div>
                  {allDiscountCodes.map((d, i) => (
                    <div key={i} style={{ fontSize: 14, color: "#856404", marginBottom: 2 }}>
                      <strong>{d.orderName}:</strong> <code style={{ background: "#fff", padding: "1px 6px", borderRadius: 4, border: "1px solid #f0c040", fontFamily: "monospace", fontWeight: 700 }}>{d.code}</code>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Layout.Section>
        )}

        {/* ── ALL PACKED BANNER ── */}
        {allPacked && (
          <Layout.Section>
            <div style={{ background: "#008060", borderRadius: 10, padding: "20px 24px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16, marginBottom: mostValuable ? 16 : 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 32 }}>✅</span>
                  <div>
                    <div style={{ color: "#fff", fontWeight: 700, fontSize: 20 }}>All items packed!</div>
                    <div style={{ color: "#a8f0d8", fontSize: 14 }}>{packItems.length} SKUs · {totalQty} items confirmed</div>
                  </div>
                </div>
                <Button variant="primary" size="large" onClick={moveToNextOrder}>Next Order →</Button>
              </div>
              {mostValuable && (
                <div style={{ background: "rgba(255,255,255,0.12)", borderRadius: 8, padding: "12px 16px", display: "flex", alignItems: "center", gap: 14 }}>
                  {mostValuable.imageUrl && (
                    <img src={mostValuable.imageUrl} alt={mostValuable.title} style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: "#ffd700", fontWeight: 700, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>⭐ Most Valuable — Pack On Top</div>
                    <div style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>{mostValuable.title}</div>
                    {mostValuable.sku && <div style={{ color: "#a8f0d8", fontSize: 13, fontFamily: "monospace" }}>{mostValuable.sku}</div>}
                  </div>
                  <div style={{ color: "#ffd700", fontWeight: 700, fontSize: 22, flexShrink: 0 }}>
                    {fmt(mostValuable.unitPrice * mostValuable.quantity, mostValuable.currencyCode)}
                  </div>
                </div>
              )}
            </div>
          </Layout.Section>
        )}

        {hasOverScan && (
          <Layout.Section>
            <div style={{ background: "#d72c0d", color: "#fff", borderRadius: 8, padding: "12px 16px", fontWeight: 700 }}>
              ⚠️ Over-scan detected — one or more items scanned more than ordered.
            </div>
          </Layout.Section>
        )}

        {/* ── NEXT ITEM HERO ── */}
        {nextItem && (
          <Layout.Section>
            <Card>
              <div style={{ display: "flex", gap: 24, alignItems: "center", padding: "8px 0" }}>
                {nextItem.imageUrl ? (
                  <img src={nextItem.imageUrl} alt={nextItem.title} style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 8, flexShrink: 0 }} />
                ) : (
                  <div style={{ width: 120, height: 120, borderRadius: 8, flexShrink: 0, background: nextColour.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, fontWeight: 700, color: nextColour.text }}>
                    {nextItem.sku ? nextItem.sku.substring(0, 2) : "?"}
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "#888", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.08em" }}>Next to pack</div>
                  {nextItem.sku ? (
                    <div style={{ display: "inline-block", background: nextColour.bg, color: nextColour.text, fontFamily: "monospace", fontWeight: 700, fontSize: 28, padding: "4px 14px", borderRadius: 6, marginBottom: 8 }}>
                      {nextItem.sku}
                    </div>
                  ) : (
                    <div style={{ marginBottom: 8 }}><Badge tone="warning">No SKU — manual item</Badge></div>
                  )}
                  <div style={{ fontSize: 15, color: "#333", marginBottom: 4 }}>
                    {nextItem.title}
                    {nextItem.variantTitle && nextItem.variantTitle !== "Default Title" ? ` · ${nextItem.variantTitle}` : ""}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                    {/jap/i.test(nextItem.title) && (
                      <span style={{ background: "#dc2626", color: "#fff", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4, textTransform: "uppercase" }}>🇯🇵 Japanese</span>
                    )}
                    {nextItem.unitPrice > 0 && (
                      <span style={{ background: "#f0f0f0", color: "#333", fontSize: 13, fontWeight: 700, padding: "2px 10px", borderRadius: 4 }}>
                        {fmt(nextItem.unitPrice, nextItem.currencyCode)}
                      </span>
                    )}
                  </div>
                  <InlineStack gap="300" blockAlign="center">
                    <div style={{ fontSize: 13, color: "#888" }}>
                      {nextItem.scanned}/{nextItem.quantity} packed
                      {nextItem.orderNames.length > 1 && ` · ${nextItem.orderNames.join(", ")}`}
                    </div>
                    {scanMsg.text && (
                      <div style={{ padding: "8px 12px", borderRadius: 6, fontWeight: 700, fontSize: 14, background: scanMsg.tone === "success" ? "#d4f57a" : scanMsg.tone === "critical" ? "#ffb3b3" : "#fff176", color: scanMsg.tone === "success" ? "#2d4a00" : scanMsg.tone === "critical" ? "#5c0000" : "#4a3800" }}>
                        {scanMsg.text}
                      </div>
                    )}
                    <Button variant="primary" onClick={() => markPacked(nextItem)}>
                      ✓ Mark as packed <kbd style={{ marginLeft: 6, background: "rgba(0,0,0,0.15)", padding: "1px 5px", borderRadius: 3, fontSize: 11 }}>J</kbd>
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
                    <Select label="Unfulfilled orders — grouped by customer" options={groupedOptions()} value={selectValue} onChange={selectOrder} />
                  )}

                  {selectedOrders.length > 0 && (
                    <BlockStack gap="200">
                      <InlineStack gap="200" wrap blockAlign="center">
                        <Badge tone="info">{selectedOrders[0].customer}</Badge>
                        <Badge>{totalQty} item{totalQty !== 1 ? "s" : ""}</Badge>
                        {selectedOrders.length > 1 && <Badge tone="attention">{selectedOrders.length} orders merged</Badge>}
                      </InlineStack>

                      {/* Email link */}
                      {customerEmail && (
                        <a
                          href={`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(customerEmail)}&su=${encodeURIComponent("Your order from Hollowlog Cards")}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 13, color: "#2563eb", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}
                        >
                          ✉️ {customerEmail}
                        </a>
                      )}

                      {/* Shipping address */}
                      {shippingAddress && (
                        <div style={{ background: "#f8f8f8", borderRadius: 6, padding: "10px 12px", fontSize: 13 }}>
                          <div style={{ fontWeight: 700, color: "#333", marginBottom: 4 }}>
                            📦 Ship to:{" "}
                            <span style={{ color: shippingAddress.name.toLowerCase() !== selectedOrders[0].customer.toLowerCase() ? "#d72c0d" : "#333" }}>
                              {shippingAddress.name}
                              {shippingAddress.name.toLowerCase() !== selectedOrders[0].customer.toLowerCase() && (
                                <span style={{ fontSize: 11, marginLeft: 6, background: "#ffeeba", color: "#856404", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>⚠️ different name</span>
                              )}
                            </span>
                          </div>
                          <div style={{ color: "#555", lineHeight: 1.6 }}>
                            {shippingAddress.address1}{shippingAddress.address2 ? `, ${shippingAddress.address2}` : ""}<br />
                            {shippingAddress.city}{shippingAddress.province ? `, ${shippingAddress.province}` : ""} {shippingAddress.zip}<br />
                            {shippingAddress.country}
                          </div>
                        </div>
                      )}

                      <Divider />

                      {/* Shipping summary */}
                      <div style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        padding: "10px 14px", borderRadius: 8,
                        background: totalShipping === 0 ? "#fff0f0" : "#f0fff4",
                        border: `2px solid ${totalShipping === 0 ? "#d72c0d" : "#008060"}`,
                      }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 14, color: totalShipping === 0 ? "#d72c0d" : "#008060" }}>
                            {totalShipping === 0 ? "❌ No shipping paid" : "✓ Shipping paid"}
                          </div>
                          <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
                            {selectedOrders.map(o => o.shippingTitle).filter((v, i, a) => a.indexOf(v) === i).join(", ")}
                          </div>
                        </div>
                        <div style={{ fontWeight: 700, fontSize: 20, color: totalShipping === 0 ? "#d72c0d" : "#008060" }}>
                          {fmt(totalShipping, currencyCode)}
                        </div>
                      </div>

                      {selectedOrders.length > 1 && selectedOrders.some(o => o.shippingAmount !== selectedOrders[0].shippingAmount) && (
                        <BlockStack gap="100">
                          {selectedOrders.map(o => (
                            <div key={o.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#888", padding: "2px 4px" }}>
                              <span>{o.name}: {o.shippingTitle}</span>
                              <span style={{ fontWeight: 700, color: o.shippingAmount === 0 ? "#d72c0d" : "#008060" }}>${o.shippingAmount.toFixed(2)}</span>
                            </div>
                          ))}
                        </BlockStack>
                      )}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {packItems.length > 0 && (
                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingMd" as="h2">Scan / Enter SKU</Text>
                    <TextField
                      label="" labelHidden value={scanValue}
                      onChange={handleScanChange}
                      onKeyDown={e => e.key === "Enter" && confirmScan()}
                      placeholder="Scan barcode or type SKU…"
                      autoComplete="off" autoCorrect="off" spellCheck={false}
                      ref={scanRef} size="large"
                    />
                    {scanMsg.text && (
                      <Box background={scanMsg.tone === "success" ? "bg-fill-success" : scanMsg.tone === "critical" ? "bg-fill-critical" : "bg-fill-warning"} padding="200" borderRadius="200">
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
                    <ProgressBar progress={progressPct} tone={hasOverScan ? "critical" : progressPct === 100 ? "success" : "highlight"} size="medium" />
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
                        <Box padding="400"><Text as="p" tone="subdued" alignment="center">{filter === "remaining" ? "🎉 All items packed!" : "No items in this view."}</Text></Box>
                      ) : (
                        filteredItems.map(item => {
                          const done = item.scanned >= item.quantity;
                          const over = item.scanned > item.quantity;
                          const partial = item.scanned > 0 && item.scanned < item.quantity;
                          const c = getPrefixColour(item.sku);
                          const isNext = item === nextItem;
                          const isMostVal = item === mostValuable && !allPacked;

                          return (
                            <div key={item.id} onClick={() => { if (item.sku) { setScanValue(item.sku); scanRef.current?.focus(); } }}
                              style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", borderRadius: "8px", border: `1px solid ${over ? "#d72c0d" : isNext ? c.bg : isMostVal ? "#f0c040" : done ? "#e3e3e3" : partial ? "#e1a900" : "#e3e3e3"}`, borderLeft: `5px solid ${c.bg}`, background: over ? "#fff4f4" : isNext ? `${c.bg}22` : isMostVal ? "#fffbeb" : done ? "#f8f8f8" : "#ffffff", cursor: item.sku ? "pointer" : "default", opacity: done ? 0.55 : 1, transition: "all 0.15s" }}>
                              {item.imageUrl ? (
                                <img src={item.imageUrl} alt={item.title} style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 5, flexShrink: 0, opacity: done ? 0.5 : 1 }} />
                              ) : (
                                <div style={{ width: 40, height: 40, borderRadius: 5, background: c.bg, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: c.text }}>
                                  {item.sku ? item.sku.substring(0, 2) : "?"}
                                </div>
                              )}
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, flexWrap: "wrap" }}>
                                  {item.sku ? (
                                    <div style={{ background: c.bg, color: c.text, fontFamily: "monospace", fontWeight: 700, fontSize: "13px", padding: "2px 7px", borderRadius: "4px", flexShrink: 0, textDecoration: done ? "line-through" : "none" }}>{item.sku}</div>
                                  ) : (
                                    <Badge tone="warning" size="small">No SKU</Badge>
                                  )}
                                  {isMostVal && <span style={{ fontSize: 10, fontWeight: 700, color: "#856404" }}>⭐</span>}
                                  {item.orderNames.length > 1 && <span style={{ fontSize: 10, color: "#888" }}>{item.orderNames.join(", ")}</span>}
                                </div>
                                <div style={{ fontSize: 12, color: done ? "#999" : "#444", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {item.title}{item.variantTitle && item.variantTitle !== "Default Title" ? ` · ${item.variantTitle}` : ""}
                                </div>
                              </div>

                              {item.unitPrice > 0 && (
                                <div style={{ fontSize: 12, fontWeight: 700, color: done ? "#aaa" : "#333", flexShrink: 0, textAlign: "right", minWidth: 44 }}>
                                  ${item.unitPrice.toFixed(2)}
                                </div>
                              )}

                              <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: "15px", color: over ? "#d72c0d" : done ? "#008060" : partial ? "#e1a900" : "#6d7175", minWidth: "46px", textAlign: "right", flexShrink: 0 }}>
                                {item.scanned}/{item.quantity}
                              </div>
                              {!done ? (
                                <div onClick={e => e.stopPropagation()}>
                                  <Button size="slim" variant="primary" onClick={() => markPacked(item)}>✓</Button>
                                </div>
                              ) : (
                                <div style={{ fontSize: "18px", width: "22px", textAlign: "center", flexShrink: 0 }}>{over ? "⚠️" : "✅"}</div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </BlockStack>
                    <Divider />
                    <InlineStack gap="200">
                      <Button onClick={undoLast} disabled={!history.length} tone="critical" variant="plain">↩ Undo <kbd style={{ marginLeft: 4, background: "#f0f0f0", padding: "1px 5px", borderRadius: 3, fontSize: 11, color: "#666" }}>K</kbd></Button>
                      <Button onClick={resetScans} tone="critical" variant="plain">Reset</Button>
                      <Button onClick={moveToNextOrder} variant="plain">Next Order <kbd style={{ marginLeft: 4, background: "#f0f0f0", padding: "1px 5px", borderRadius: 3, fontSize: 11, color: "#666" }}>Space</kbd></Button>
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
              <EmptyState heading="Loading orders..." image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                <p>Orders are grouped by customer and the most recent loads automatically.</p>
              </EmptyState>
            </Card>
          </Layout.Section>
        )}

      </Layout>
    </Page>
  );
}
