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
import { translate, getCurrentLang } from "../i18n/index.js";

export type Fulfillment = "physical" | "service" | "digital";

export type Category = "marketplace" | "p2p-trade" | "bill-pay" | "lending" | "raw-escrow" | "chama" | "chama-share";

// i18n (namespace "labels"): the tables below hold i18n KEYS, not display
// strings — safe at module load. getVoteLabel resolves the key through
// translate(getCurrentLang(), …) at call time, so the button re-renders in the
// live language. English output is byte-identical to the pre-i18n strings
// (tests.ts asserts on it).

export interface VotePair {
  /** i18n key for the button text when voting RELEASE */
  release: string;
  /** i18n key for the button text when voting REFUND */
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
  buyer:   { release: "labels.voteNeutralRelease", refund: "labels.voteNeutralRefund" },
  seller:  { release: "labels.voteNeutralRelease", refund: "labels.voteNeutralRefund" },
  arbiter: { release: "labels.voteNeutralRelease", refund: "labels.voteNeutralRefund" },
};

const ARBITER_NEUTRAL: VotePair = { release: "labels.voteSideWithBuyer", refund: "labels.voteSideWithSeller" };

// Composite key: `${category}:${fulfillment}` — flat table, trivially
// extensible. Marketplace is the only vertical with three entries; the
// others map to "service" because their labels don't depend on whether
// the trade is for a thing, a service, or a file.
const TABLE: Record<string, CategoryLabels> = {
  // ── Marketplace — physical goods ────────────────────────────────────
  "marketplace:physical": {
    buyer:  { release: "labels.voteMarketplacePhysicalBuyerRelease",  refund: "labels.voteMarketplacePhysicalBuyerRefund" },
    seller: { release: "labels.voteMarketplacePhysicalSellerRelease", refund: "labels.voteMarketplacePhysicalSellerRefund" },
    arbiter: ARBITER_NEUTRAL,
  },
  // ── Marketplace — service ───────────────────────────────────────────
  "marketplace:service": {
    buyer:  { release: "labels.voteMarketplaceServiceBuyerRelease",  refund: "labels.voteMarketplaceServiceBuyerRefund" },
    seller: { release: "labels.voteMarketplaceServiceSellerRelease", refund: "labels.voteMarketplaceServiceSellerRefund" },
    arbiter: ARBITER_NEUTRAL,
  },
  // ── Marketplace — digital goods ─────────────────────────────────────
  "marketplace:digital": {
    buyer:  { release: "labels.voteMarketplaceDigitalBuyerRelease",  refund: "labels.voteMarketplaceDigitalBuyerRefund" },
    seller: { release: "labels.voteMarketplaceDigitalSellerRelease", refund: "labels.voteMarketplaceDigitalSellerRefund" },
    arbiter: ARBITER_NEUTRAL,
  },
  // ── P2P — fiat exchange (always "service") ──────────────────────────
  "p2p-trade:service": {
    buyer:  { release: "labels.voteP2pBuyerRelease",  refund: "labels.voteP2pBuyerRefund" },
    seller: { release: "labels.voteP2pSellerRelease", refund: "labels.voteP2pSellerRefund" },
    arbiter: ARBITER_NEUTRAL,
  },
  // ── Bill Pay — the VOLUNTEER (buyer role) pays the owner's fiat bill
  //    off-chain and is paid in sats on RELEASE; the BILL OWNER (seller
  //    role) locks the sats and is refunded on REFUND. This mirrors the
  //    sats routing (recipients.ts: RELEASE→buyer, REFUND→seller) and the
  //    locker convention (state-machine.ts: bill-pay locker = seller). The
  //    volunteer is the deed-doer, so they vote FIRST ("I paid the bill as
  //    a volunteer"); the owner then confirms. The volunteer's refund is
  //    the back-out hatch — cancel so the owner is refunded and can find
  //    someone else. (3.5.1 fix: buyer↔seller bodies were swapped, which
  //    read as a role reversal on the device pass; routing was always right,
  //    only these labels + the turn order in decisions.ts were inverted.) ──
  "bill-pay:service": {
    buyer:  { release: "labels.voteBillPayBuyerRelease",  refund: "labels.voteBillPayBuyerRefund" },
    seller: { release: "labels.voteBillPaySellerRelease", refund: "labels.voteBillPaySellerRefund" },
    arbiter: ARBITER_NEUTRAL,
  },
  // ── Lending — first cycle (loan disbursement). The borrower's first
  //    vote leans FORWARD — acknowledge receipt + repayment intent — and
  //    their refund is the credit-responsible decline: what a repayment-
  //    aware borrower says when their situation has changed. The
  //    repayment cycle is a separate Option B trade with reversed roles.
  "lending:service": {
    buyer:  { release: "labels.voteLendingBuyerRelease",  refund: "labels.voteLendingBuyerRefund" },
    seller: { release: "labels.voteLendingSellerRelease", refund: "labels.voteLendingSellerRefund" },
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
  return translate(
    getCurrentLang(),
    outcome === Outcome.RELEASE ? pair.release : pair.refund,
  );
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
