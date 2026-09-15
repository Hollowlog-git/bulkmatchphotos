export interface DrawerRangeConfig {
  drawerNumber: number;
  startSku: string | null;
  endSku: string | null;
}

export function normaliseSku(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, "");
  const m = s.match(/^([A-Z]{2})-?(\d{1,3})$/);
  if (!m) return s;
  return m[1] + "-" + m[2].padStart(3, "0");
}

export function skuSortKey(sku: string): string {
  const m = sku.match(/^([A-Z]{2})-(\d+)$/);
  if (!m) return sku;
  return m[1] + m[2].padStart(6, "0");
}

// Finds which configured drawer a SKU falls into. Drawers with no startSku
// are unconfigured ("currently none") and never match. When ranges overlap,
// the lowest drawer number wins.
export function resolveDrawerNumber(sku: string, drawers: DrawerRangeConfig[]): number | null {
  const target = skuSortKey(normaliseSku(sku));
  const matches = drawers.filter((d) => {
    if (!d.startSku) return false;
    const startKey = skuSortKey(normaliseSku(d.startSku));
    if (target < startKey) return false;
    if (d.endSku) {
      const endKey = skuSortKey(normaliseSku(d.endSku));
      if (target > endKey) return false;
    }
    return true;
  });
  if (!matches.length) return null;
  return matches.sort((a, b) => a.drawerNumber - b.drawerNumber)[0].drawerNumber;
}
