// Prepacking contract v1: may a package be SENT? (Not whether it may be
// packed: under v1 anything won can be packed, paid or not.)
//
// The local Trade Me app reports each parcel's dispatch clearance; Shopify
// reports each order's payment. A package is cleared only when EVERY source
// in it is cleared. A paid Shopify order never clears unpaid Trade Me
// companions, or vice versa. Unknown or absent clearance is never "cleared".
// Scanning never changes clearance; it only comes from the latest data.

export type ClearanceState =
  | "cleared"
  | "blocked" // hold, cancellation, refund, dispatched, or unknown parcel state
  | "payment_outstanding"
  | "shipping_not_cleared"
  | "unknown"; // not reported (older sync, or not in the latest sync)

export interface Clearance { state: ClearanceState; reasons: string[] }

export const BLOCKER_TEXT: Record<string, string> = {
  payment_not_confirmed: "payment not confirmed",
  shipping_not_cleared: "shipping not cleared",
  hold_or_unknown: "on hold (or hold status unknown)",
  cancelled_or_unknown: "cancelled (or status unknown)",
  dispatched_or_unknown: "already dispatched (or status unknown)",
};

// Severity order: the worst state wins when sources are combined.
const RANK: ClearanceState[] = ["blocked", "payment_outstanding", "shipping_not_cleared", "unknown", "cleared"];

export function tradeMeJobClearance(job: {
  dispatchClearance?: string | null;
  dispatchBlockers?: string[] | null;
  paymentStatus?: string | null;
  shippingStatus?: string | null;
}): Clearance {
  const blockers = job.dispatchBlockers ?? [];
  if (job.dispatchClearance === "cleared" && blockers.length === 0) return { state: "cleared", reasons: [] };
  if (job.dispatchClearance !== "cleared" && job.dispatchClearance !== "blocked") {
    return { state: "unknown", reasons: ["Trade Me clearance not reported"] };
  }
  const reasons = blockers.map((b) => BLOCKER_TEXT[b] ?? b);
  if (job.paymentStatus && job.paymentStatus !== "paid" && !blockers.includes("payment_not_confirmed")) {
    reasons.push(`payment ${job.paymentStatus.replace(/_/g, " ")}`);
  }
  // "cleared" alongside blockers is contradictory: treat it as blocked.
  const severe = blockers.some((b) => b === "hold_or_unknown" || b === "cancelled_or_unknown" || b === "dispatched_or_unknown")
    || blockers.some((b) => !(b in BLOCKER_TEXT));
  const state: ClearanceState = severe ? "blocked"
    : blockers.includes("payment_not_confirmed") || (job.paymentStatus && job.paymentStatus !== "paid") ? "payment_outstanding"
    : blockers.includes("shipping_not_cleared") ? "shipping_not_cleared"
    : "blocked";
  return { state, reasons: reasons.length ? reasons : ["not cleared to send"] };
}

export function shopifyOrderClearance(financialStatus: string | null | undefined, cancelled = false): Clearance {
  if (cancelled) return { state: "blocked", reasons: ["Shopify order cancelled"] };
  switch (financialStatus) {
    case "PAID":
    case "PARTIALLY_REFUNDED":
      return { state: "cleared", reasons: [] };
    case "PENDING":
    case "AUTHORIZED":
    case "PARTIALLY_PAID":
    case "EXPIRED":
      return { state: "payment_outstanding", reasons: [`Shopify payment ${financialStatus.toLowerCase().replace(/_/g, " ")}`] };
    case "REFUNDED":
    case "VOIDED":
      return { state: "blocked", reasons: [`Shopify order ${financialStatus.toLowerCase()}`] };
    default:
      return { state: "unknown", reasons: ["Shopify payment status unknown"] };
  }
}

export function combineClearance(sources: Clearance[]): Clearance {
  if (!sources.length) return { state: "unknown", reasons: ["nothing to assess"] };
  const state = RANK.find((r) => sources.some((s) => s.state === r)) ?? "unknown";
  const reasons = [...new Set(sources.flatMap((s) => s.reasons))];
  return { state, reasons };
}

export const CLEARANCE_LABEL: Record<ClearanceState, string> = {
  cleared: "Cleared after packing",
  payment_outstanding: "Prepack — payment outstanding",
  shipping_not_cleared: "Shipping not cleared",
  blocked: "Do not send — blocked",
  unknown: "Send status unknown — check before sending",
};
