// ══════════════════════════════════════════════════════════════════════════
// Chama — Vertical-aware vote button labels
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §State 4 (vote moment) and §State 8 (per-vertical
// inheritance): each vertical inherits the same eight-state spine but
// uses different vote labels. Marketplace splits by fulfillment
// (physical / service / digital); P2P, Bill Pay, and Lending have a
// single canonical label set per role.
//
// Keyed off (category, fulfillment, role). Non-marketplace verticals
// always have fulfillment "service" — the field is generic to all
// listings (Jetty's PR 2 call #3), and the dictionary just looks up
// the (category, "service", role) entry for them.
//
// Outcomes (release / refund) are the protocol-level Outcome enum:
//   release → sats go to the non-locker (buyer in p2p, seller in marketplace)
//   refund  → sats return to the locker
// The button text describes what THIS PARTICIPANT is asserting by voting
// that outcome — not the outcome itself.

import { Role, Outcome } from "../escrow-engine/types.js";

export type Fulfillment = "physical" | "service" | "digital";

export type Category = "marketplace" | "p2p-trade" | "bill-pay" | "lending" | "raw-escrow";

export interface VotePair {
  /** Button text when voting RELEASE */
  release: string;
  /** Button text when voting REFUND */
  refund: string;
}

export interface CategoryLabels {
  buyer:  VotePair;
  seller: VotePair;
  /** Arbiter button text. Optional — falls back to the neutral "side
   *  with X" set when not specified, since the arbiter is voting on
   *  someone else's outcome and generic wording is honest. */
  arbiter?: VotePair;
}

const NEUTRAL: CategoryLabels = {
  buyer:   { release: "Release sats", refund: "Refund sats" },
  seller:  { release: "Release sats", refund: "Refund sats" },
  arbiter: { release: "Release sats", refund: "Refund sats" },
};

const ARBITER_NEUTRAL: VotePair = { release: "Side with buyer", refund: "Side with seller" };

// Composite key: `${category}:${fulfillment}` — flat table, trivially
// extensible. Marketplace is the only vertical with three entries; the
// others map to "service" because their labels don't depend on whether
// the trade is for a thing, a service, or a file.
const TABLE: Record<string, CategoryLabels> = {
  // ── Marketplace — physical goods ────────────────────────────────────
  "marketplace:physical": {
    buyer:  { release: "I received it",  refund: "I didn't get it" },
    seller: { release: "Item delivered", refund: "Buyer never received" },
    arbiter: ARBITER_NEUTRAL,
  },
  // ── Marketplace — service ───────────────────────────────────────────
  "marketplace:service": {
    buyer:  { release: "I received the service", refund: "Service not delivered" },
    seller: { release: "Service rendered",       refund: "Buyer didn't accept" },
    arbiter: ARBITER_NEUTRAL,
  },
  // ── Marketplace — digital goods ─────────────────────────────────────
  "marketplace:digital": {
    buyer:  { release: "I received the file", refund: "File never arrived" },
    seller: { release: "Delivered",           refund: "Buyer didn't receive" },
    arbiter: ARBITER_NEUTRAL,
  },
  // ── P2P — fiat exchange (always "service") ──────────────────────────
  "p2p-trade:service": {
    buyer:  { release: "I sent the fiat", refund: "Cancel — never sent fiat" },
    seller: { release: "Fiat received",   refund: "Fiat not received" },
    arbiter: ARBITER_NEUTRAL,
  },
  // ── Bill Pay — sats-receiver (seller) pays buyer's fiat bill ────────
  "bill-pay:service": {
    buyer:  { release: "My bill was paid",   refund: "Bill not paid" },
    seller: { release: "Bill has been paid", refund: "Couldn't pay the bill" },
    arbiter: ARBITER_NEUTRAL,
  },
  // ── Lending — first cycle (loan disbursement). The repayment cycle
  //    is a separate Option B trade with reversed roles; its labels
  //    will land alongside the lending vertical itself. ───────────────
  "lending:service": {
    buyer:  { release: "I got the loan", refund: "Loan didn't arrive" },
    seller: { release: "Loan disbursed", refund: "Borrower didn't accept" },
    arbiter: ARBITER_NEUTRAL,
  },
};

/** Look up the vote labels for the given category+fulfillment+role.
 *  Falls back to neutral "Release sats" / "Refund sats" when the
 *  combination is unknown (raw-escrow, future verticals, etc.). */
export function getVoteLabel(
  category: string | undefined,
  fulfillment: string | undefined,
  role: Role,
  outcome: Outcome,
): string {
  const key = `${category ?? "raw-escrow"}:${fulfillment ?? "service"}`;
  const entry = TABLE[key] ?? NEUTRAL;
  const pair =
    role === Role.BUYER  ? entry.buyer  :
    role === Role.SELLER ? entry.seller :
    (entry.arbiter ?? ARBITER_NEUTRAL);
  return outcome === Outcome.RELEASE ? pair.release : pair.refund;
}

/** Default fulfillment for a given category. Marketplace defaults to
 *  "physical" (the form should still force the user to pick); other
 *  categories are always "service". Per Jetty's PR 2 call #3:
 *  fulfillment is generic to any listing but auto-set by category for
 *  non-marketplace. */
export function defaultFulfillmentFor(category: string | undefined): Fulfillment {
  return category === "marketplace" ? "physical" : "service";
}

/** Whether the user should be allowed to pick a fulfillment value for
 *  this category. Marketplace is the only vertical where it's a real
 *  choice; everywhere else the fulfillment is a derived constant. */
export function categoryAllowsFulfillmentChoice(category: string | undefined): boolean {
  return category === "marketplace";
}
