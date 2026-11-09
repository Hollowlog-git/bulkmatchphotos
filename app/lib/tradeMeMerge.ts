// Decides which Trade Me clearance job (synced from the local app) belongs in
// the same physical package as a buyer's Shopify orders.
//
// Shopify orders keep Pack Check's existing grouping (by customer name). A
// Trade Me job is attached to one of those groups only when the match is
// unambiguous and backed by more than a name:
//   - the buyer email matches (normalised), and every Shopify order in the
//     group with an email has that same email; and
//   - every Shopify order in the group with an address has an address
//     compatible with the job's delivery address (street line and postcode
//     both appear in it), and at least one does.
// One job may match one group, and one group may take one job; anything else
// is ambiguous and everything stays separate. Unmatched jobs get their own
// package. Orders are never altered — only a packKey is assigned — so every
// Shopify order/line id and Trade Me groupKey/purchase id stays intact.

export interface MergeAddress {
  address1: string;
  zip: string;
}

export interface MergeableOrder {
  id: string;
  customer: string;
  customerEmail: string | null;
  shippingAddress: MergeAddress | null;
  deliveryAddressText?: string | null;
  tradeMe?: { groupKey: string } | null;
}

export type WithPackKey<T> = T & { packKey: string };

const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
const normEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();

export function addressCompatible(sa: MergeAddress | null, text: string | null | undefined): boolean {
  if (!sa || !text) return false;
  const t = words(text);
  const street = words(sa.address1).trim();
  const zip = words(sa.zip).trim();
  if (!street) return false;
  if (!t.includes(` ${street} `)) return false;
  if (zip && !t.includes(` ${zip} `)) return false;
  return true;
}

function groupAccepts(group: MergeableOrder[], job: MergeableOrder): boolean {
  const email = normEmail(job.customerEmail);
  if (!email) return false;
  const emails = group.map((o) => normEmail(o.customerEmail)).filter(Boolean);
  if (!emails.length || emails.some((e) => e !== email)) return false;
  const withAddress = group.filter((o) => o.shippingAddress);
  if (!withAddress.length) return false;
  return withAddress.every((o) => addressCompatible(o.shippingAddress, job.deliveryAddressText));
}

export function assignPackKeys<T extends MergeableOrder>(orders: T[]): WithPackKey<T>[] {
  const shopifyGroups = new Map<string, T[]>();
  for (const o of orders) {
    if (o.tradeMe) continue;
    if (!shopifyGroups.has(o.customer)) shopifyGroups.set(o.customer, []);
    shopifyGroups.get(o.customer)!.push(o);
  }

  const jobs = orders.filter((o) => o.tradeMe);
  const candidates = new Map<string, string[]>(); // job id -> matching group keys
  const claims = new Map<string, number>(); // group key -> number of jobs matching it
  for (const job of jobs) {
    const keys = [...shopifyGroups.entries()].filter(([, g]) => groupAccepts(g, job)).map(([k]) => k);
    candidates.set(job.id, keys);
    for (const k of keys) claims.set(k, (claims.get(k) ?? 0) + 1);
  }

  return orders.map((o) => {
    if (!o.tradeMe) return { ...o, packKey: o.customer };
    const keys = candidates.get(o.id) ?? [];
    const merged = keys.length === 1 && claims.get(keys[0]) === 1;
    return { ...o, packKey: merged ? keys[0] : `trademe:${o.tradeMe.groupKey}` };
  });
}
