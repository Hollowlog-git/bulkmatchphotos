// Trade Me items without a usable picking SKU (blank, or a "TV|..." integration
// reference) aren't shown as pickable cards. The local app already filters
// these; Pack Check applies the same rule as a backstop, and the packing
// revalidation uses it so both agree on what a job's pickable items are.
export function isPickableSku(sku: string | null | undefined): boolean {
  const s = (sku ?? "").trim();
  return s.length > 0 && !s.toUpperCase().startsWith("TV|");
}
