import { addressCompatible, addressTokens, type MergeAddress } from "./tradeMeMerge";
import type { ClearanceState } from "./clearance";

// Does the package being packed belong in a bag that's already packed and
// waiting to be sent?
//
//   definite   — shares a Trade Me parcel (groupKey) with exactly one waiting
//                bag: the local app says it's the same parcel. Added to that
//                bag automatically.
//   suggest    — a different parcel/order for the same buyer (same email or
//                Trade Me username, never a name alone), exactly one waiting
//                bag, and the delivery addresses are compatible. Only combined
//                if the packer confirms.
//   unconfirmed_address — same buyer, one waiting bag, but the addresses
//                differ or can't be checked: pack separately.
//   blocked    — the matching bag is held, cancelled, dispatched or of unknown
//                status: never combine.
//   ambiguous  — more than one candidate bag: never combine; check by hand.

export interface BagAddress { text?: string | null; structured?: MergeAddress | null }

export interface BagIdentity {
  groupKeys: string[];
  emails: string[];
  usernames: string[];
  addresses: BagAddress[];
}

export interface WaitingBag extends BagIdentity {
  bagId: string;
  code: string;
  label: string;
  packedAt: string;
  clearanceState: ClearanceState;
  items: { sku: string; title: string; quantity: number }[];
}

export type BagMatch =
  | { kind: "definite"; bag: WaitingBag }
  | { kind: "suggest"; bag: WaitingBag }
  | { kind: "unconfirmed_address"; bag: WaitingBag }
  | { kind: "blocked"; bag: WaitingBag }
  | { kind: "ambiguous"; bags: WaitingBag[] };

export const bagCode = (bagId: string) => `BAG-${bagId.replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase()}`;

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const overlap = (a: string[], b: string[]) => {
  const set = new Set(a.map(norm).filter(Boolean));
  return b.map(norm).some((x) => x && set.has(x));
};

// Statuses a bag may be added to. Blocked (hold, cancel, dispatch) and
// unknown (e.g. gone from the latest sync, maybe dispatched) are excluded.
const ADDABLE: ClearanceState[] = ["cleared", "payment_outstanding", "shipping_not_cleared"];

function textCompatible(a: string, b: string): boolean {
  const ta = addressTokens(a), tb = new Set(addressTokens(b));
  const ka = ta.filter((w) => /\d/.test(w)); // house number, postcode, unit
  return ka.length >= 2 && ka.every((w) => tb.has(w)) && ta.filter((w) => !/\d/.test(w)).length > 0
    && addressTokens(b).filter((w) => /\d/.test(w)).every((w) => new Set(ta).has(w));
}

export function addressesCompatible(a: BagAddress[], b: BagAddress[]): boolean {
  const known = (xs: BagAddress[]) => xs.filter((x) => x.text || x.structured);
  const A = known(a), B = known(b);
  if (!A.length || !B.length) return false; // can't check: not compatible
  const pair = (x: BagAddress, y: BagAddress) =>
    x.structured && y.text ? addressCompatible(x.structured, y.text)
    : y.structured && x.text ? addressCompatible(y.structured, x.text)
    : x.structured && y.structured ? addressCompatible(x.structured, `${y.structured.address1} ${y.structured.zip}`)
    : x.text && y.text ? textCompatible(x.text, y.text) && textCompatible(y.text, x.text)
    : false;
  // Every known address on one side must agree with every one on the other.
  return A.every((x) => B.every((y) => pair(x, y)));
}

export function matchBags(current: BagIdentity, bags: WaitingBag[]): BagMatch | null {
  const sameParcel = bags.filter((b) => overlap(b.groupKeys, current.groupKeys));
  if (sameParcel.length > 1) return { kind: "ambiguous", bags: sameParcel };
  if (sameParcel.length === 1) {
    const bag = sameParcel[0];
    return ADDABLE.includes(bag.clearanceState) ? { kind: "definite", bag } : { kind: "blocked", bag };
  }
  const sameBuyer = bags.filter((b) => overlap(b.emails, current.emails) || overlap(b.usernames, current.usernames));
  if (!sameBuyer.length) return null;
  if (sameBuyer.length > 1) return { kind: "ambiguous", bags: sameBuyer };
  const bag = sameBuyer[0];
  if (!ADDABLE.includes(bag.clearanceState)) return { kind: "blocked", bag };
  return addressesCompatible(bag.addresses, current.addresses) ? { kind: "suggest", bag } : { kind: "unconfirmed_address", bag };
}

// Packed-view data → bags waiting to be sent. Packages sharing a bagId are
// one physical bag. Old-button Trade Me parcels (no package record) become
// bags that can be matched but not filed into (`fileable: false`).
interface PackedPkgLike {
  id: string; bagId: string; bagCode: string; label: string; customer?: string; packedAt: string;
  identity: BagIdentity; items: { sku: string; title: string; quantity: number }[];
  clearance?: { state: ClearanceState; reasons: string[] };
}
interface LegacyLike {
  groupKey: string; packedAt: string; buyer: string | null; purchaseIds: string[];
  identity?: BagIdentity; clearance?: { state: ClearanceState; reasons: string[] };
}
export interface WaitingBagFull extends WaitingBag { fileable: boolean; packageIds: string[] }

const RANK: ClearanceState[] = ["blocked", "payment_outstanding", "shipping_not_cleared", "unknown", "cleared"];
const worst = (states: ClearanceState[]): ClearanceState => RANK.find((r) => states.includes(r)) ?? "unknown";
const uniq = (xs: string[]) => [...new Set(xs)];

export function buildWaitingBags(packages: PackedPkgLike[], legacy: LegacyLike[] = []): WaitingBagFull[] {
  const byBag = new Map<string, PackedPkgLike[]>();
  for (const p of packages) byBag.set(p.bagId, [...(byBag.get(p.bagId) ?? []), p]);
  const bags: WaitingBagFull[] = [...byBag.entries()].map(([bagId, pkgs]) => {
    const first = [...pkgs].sort((a, b) => a.packedAt.localeCompare(b.packedAt))[0];
    return {
      bagId,
      code: first.bagCode,
      label: first.customer || first.label,
      packedAt: first.packedAt,
      clearanceState: worst(pkgs.map((p) => p.clearance?.state ?? "unknown")),
      items: pkgs.flatMap((p) => p.items),
      groupKeys: uniq(pkgs.flatMap((p) => p.identity?.groupKeys ?? [])),
      emails: uniq(pkgs.flatMap((p) => p.identity?.emails ?? [])),
      usernames: uniq(pkgs.flatMap((p) => p.identity?.usernames ?? [])),
      addresses: pkgs.flatMap((p) => p.identity?.addresses ?? []),
      fileable: true,
      packageIds: pkgs.map((p) => p.id),
    };
  });
  for (const l of legacy) {
    bags.push({
      bagId: `legacy:${l.groupKey}`,
      code: `PARCEL-${l.groupKey}`,
      label: l.buyer ?? `Trade Me parcel ${l.groupKey}`,
      packedAt: l.packedAt,
      clearanceState: l.clearance?.state ?? "unknown",
      items: l.purchaseIds.map((id) => ({ sku: "", title: `Trade Me purchase ${id}`, quantity: 1 })),
      groupKeys: uniq([l.groupKey, ...(l.identity?.groupKeys ?? [])]),
      emails: l.identity?.emails ?? [],
      usernames: l.identity?.usernames ?? [],
      addresses: l.identity?.addresses ?? [],
      fileable: false,
      packageIds: [],
    });
  }
  return bags;
}
