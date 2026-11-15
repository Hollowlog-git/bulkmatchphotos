import { CLEARANCE_LABEL, type Clearance, type ClearanceState } from "./clearance";

// Is a packed bag ready to ship? Only when ALL of these hold:
//   - nothing is left to pack in its parcels,
//   - no items from the same buyer are waiting in another parcel,
//   - every source is cleared (goods paid, shipping cleared, no hold).
// Anything else is "don't send yet", with the reasons.

interface PkgLike { clearance?: Clearance; remainingToPack?: number; possibleAdditions?: number }

const RANK: ClearanceState[] = ["blocked", "payment_outstanding", "shipping_not_cleared", "unknown", "cleared"];

export function bagClearance(pkgs: PkgLike[]): Clearance {
  const state = RANK.find((r) => pkgs.some((p) => (p.clearance?.state ?? "unknown") === r)) ?? "unknown";
  return { state, reasons: [...new Set(pkgs.flatMap((p) => p.clearance?.reasons ?? []))] };
}

export function bagVerdict(pkgs: PkgLike[], waitingInToPack: string[] = []) {
  const clearance = bagClearance(pkgs);
  const remainingToPack = Math.max(0, ...pkgs.map((p) => p.remainingToPack ?? 0));
  const possibleAdditions = Math.max(0, ...pkgs.map((p) => p.possibleAdditions ?? 0));
  const holds = [
    remainingToPack ? `${remainingToPack} new item${remainingToPack !== 1 ? "s" : ""} still to pack` : "",
    possibleAdditions ? `${possibleAdditions} item${possibleAdditions !== 1 ? "s" : ""} from the same buyer waiting in another parcel — check whether they go in this bag` : "",
    waitingInToPack.length ? `waiting in To pack to be added: ${waitingInToPack.slice(0, 6).join(", ")}${waitingInToPack.length > 6 ? ` +${waitingInToPack.length - 6} more` : ""}` : "",
    clearance.state !== "cleared" ? CLEARANCE_LABEL[clearance.state].toLowerCase() : "",
  ].filter(Boolean);
  return { ready: holds.length === 0, holds, clearance, remainingToPack, possibleAdditions };
}
