import { normaliseSku, skuSortKey } from "./sku";

// Builds a package's pick list from its orders. Lines with the same SKU are
// combined into one card and their quantities added, so separate purchases
// of one SKU keep their full count. Shopify orders are processed before
// Trade Me jobs, so a Shopify product image wins for a shared SKU; a Trade
// Me photo only fills in where the Shopify line has none. Trade Me-only
// lines keep their own photo.

interface BaseLine {
  id: string;
  sku: string;
  title: string;
  quantity: number;
  imageUrl?: string | null;
}
interface BaseOrder<L extends BaseLine> {
  name: string;
  tradeMe?: unknown;
  lineItems: L[];
}
export type PackLine<L> = L & { scanned: number; sortKey: string; orderNames: string[] };

export function buildPackItems<L extends BaseLine>(
  orders: BaseOrder<L>[],
  scannedMap?: Record<string, number>,
): PackLine<L>[] {
  const ordered = [...orders].sort((a, b) => Number(!!a.tradeMe) - Number(!!b.tradeMe));
  const map = new Map<string, PackLine<L>>();
  for (const order of ordered) {
    for (const item of order.lineItems) {
      const sku = normaliseSku(item.sku || "");
      const key = sku || item.id;
      const existing = map.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        if (!existing.imageUrl && item.imageUrl) existing.imageUrl = item.imageUrl;
        if (!existing.orderNames.includes(order.name)) existing.orderNames.push(order.name);
      } else {
        map.set(key, { ...item, sku, scanned: 0, sortKey: sku ? skuSortKey(sku) : `ZZZ_${item.title}`, orderNames: [order.name] });
      }
    }
  }
  if (scannedMap) {
    for (const [key, count] of Object.entries(scannedMap)) {
      const item = map.get(key);
      if (item) item.scanned = count;
    }
  }
  return [...map.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}
