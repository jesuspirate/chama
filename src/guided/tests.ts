import {
  EscrowStatus,
  Role,
  type EscrowState,
  type MenuItem,
} from "../escrow-engine/types.js";
import { validateGuidedTradeIntent } from "./intent-validation.js";
import { matchGuidedListings, recommendGuidedCandidates } from "./match-listings.js";
import type { GuidedTradeIntent } from "./types.js";

let passed = 0;
let failed = 0;

function assert(condition: unknown, name: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

const NOW = 1_800_000_000;
const INTENT: GuidedTradeIntent = {
  version: 1,
  direction: "buy_sats",
  amountSats: 50_000,
  paymentRails: ["cash-app", "m-pesa"],
  strategy: "available_now",
  community: "global-usd",
  mintUrl: "fed1-guided",
};

function listing(
  id: string,
  overrides: Partial<EscrowState> = {},
): EscrowState {
  return {
    id,
    status: EscrowStatus.CREATED,
    escrowMode: "ecash",
    settlementPolicy: "ecash-mutual-slices-v1",
    description: `${id} sats offer`,
    amountMsats: 50_000_000,
    fiatAmount: 43,
    fiatCurrency: "USD",
    premiumBps: 0,
    category: "p2p-trade",
    paymentMethods: ["cash-app"],
    fulfillment: "service",
    community: "global-usd",
    mintUrl: "fed1-guided",
    participants: {
      [Role.BUYER]: null,
      [Role.SELLER]: `seller-${id}`,
      [Role.ARBITER]: null,
    },
    joinHolds: {},
    initiator: { pubkey: `seller-${id}`, role: Role.SELLER },
    communityArbiters: [],
    subscription: null,
    votes: {},
    resolvedOutcome: null,
    resolvedMajority: null,
    fees: {
      platformBps: 0,
      platformPubkey: "",
      platformMsats: 0,
      arbiterMsats: 1_000,
    },
    lock: {
      notesHash: null,
      lockedAt: null,
      shares: new Map(),
      handle: null,
    },
    claim: { claimerRole: null, claimedAt: null },
    createdAt: NOW - 60,
    listingExpiresAt: NOW + 3_600,
    expiresAt: NOW + 3_600,
    resolvedAt: null,
    completedAt: null,
    cancelledAt: null,
    eventChain: [],
    chatMessages: [],
    ...overrides,
  };
}

console.log("\n── GUIDED INTENT VALIDATION ──");
{
  const parsed = validateGuidedTradeIntent({
    version: 1,
    direction: "buy_sats",
    amountSats: 50_000,
    paymentRails: [" Cash-App ", "cash-app", "M-PESA"],
    strategy: "available_now",
    community: "GLOBAL-USD",
    mintUrl: " fed1-guided ",
  });
  assert(
    parsed.ok
      && JSON.stringify(parsed.value.paymentRails) === JSON.stringify(["cash-app", "m-pesa"])
      && parsed.value.community === "global-usd"
      && parsed.value.mintUrl === "fed1-guided",
    "normalizes language-neutral rail, community, and route fields",
  );

  const invalid = validateGuidedTradeIntent({
    version: 1,
    direction: "buy_sats",
    amountSats: 1.5,
    paymentRails: [],
    strategy: "best_today",
    executeNow: true,
  });
  assert(
    !invalid.ok
      && new Set(invalid.issues.map(value => value.code)).has("UNKNOWN_FIELD")
      && new Set(invalid.issues.map(value => value.code)).has("INVALID_AMOUNT")
      && new Set(invalid.issues.map(value => value.code)).has("INVALID_PAYMENT_RAILS")
      && new Set(invalid.issues.map(value => value.code)).has("INVALID_STRATEGY"),
    "rejects unknown execution-like fields and invalid constrained values",
  );

  const incompleteLimit = validateGuidedTradeIntent({
    version: 1,
    direction: "buy_sats",
    amountSats: 50_000,
    paymentRails: ["cash-app"],
    strategy: "available_now",
    maxFiatAmount: 45,
  });
  assert(
    !incompleteLimit.ok
      && incompleteLimit.issues.some(value => value.code === "INCOMPLETE_FIAT_LIMIT"),
    "requires fiat limit amount and currency as one atomic constraint",
  );
}

console.log("\n── GUIDED DETERMINISTIC MATCHING ──");
{
  const eligible = listing("eligible");
  const wrongRail = listing("wrong-rail", { paymentMethods: ["m-pesa"] });
  const expired = listing("expired", { listingExpiresAt: NOW, expiresAt: NOW });
  const result = matchGuidedListings(INTENT, [
    { listing: eligible },
    { listing: wrongRail },
    { listing: expired },
  ], { nowSec: NOW, limit: 10 });
  assert(
    result.candidates.map(value => value.listing.id).join(",") === "eligible,wrong-rail",
    "accepts any requested compatible rail and keeps deterministic ordering",
  );
  assert(
    result.rejected.some(value => value.listingId === "expired" && value.code === "EXPIRED"),
    "rejects listings at their expiry boundary",
  );

  const reserved = listing("reserved", {
    joinHolds: {
      [Role.BUYER]: {
        role: Role.BUYER,
        pubkey: "someone-else",
        joinedAt: NOW - 30,
        expiresAt: NOW + 30,
        eventId: "join-1",
      },
    },
  });
  const own = listing("own", {
    participants: {
      [Role.BUYER]: null,
      [Role.SELLER]: "me",
      [Role.ARBITER]: null,
    },
  });
  const unavailable = matchGuidedListings(INTENT, [
    { listing: reserved },
    { listing: own },
    { listing: listing("stock"), availableUnits: 0 },
  ], { nowSec: NOW, viewerPubkey: "me", limit: 10 });
  assert(
    unavailable.candidates.length === 0
      && unavailable.rejected.map(value => value.code).join(",")
        === "RESERVED,SELF_LISTING,OUT_OF_STOCK",
    "conservatively rejects reserved, self-owned, and out-of-stock offers",
  );

  const bracket: MenuItem = {
    id: "range",
    label: "Flexible exchange",
    kind: "exchange-bracket",
    amountMsats: 25_000_000,
    minAmountMsats: 25_000_000,
    maxAmountMsats: 100_000_000,
    fiatAmount: 42,
    fiatCurrency: "USD",
  };
  const bracketResult = matchGuidedListings(INTENT, [
    { listing: listing("bracket", { items: [bracket], amountMsats: 25_000_000 }) },
  ], { nowSec: NOW });
  assert(
    bracketResult.candidates[0]?.selectedItem?.amountMsats === 50_000_000
      && bracketResult.candidates[0]?.selectedItem?.quantity === 1
      && bracketResult.candidates[0]?.reasons.includes("amount_in_range"),
    "maps a requested amount inside an existing exchange bracket to a lock-compatible selection",
  );

  const limited = matchGuidedListings({
    ...INTENT,
    fiatCurrency: "USD",
    maxFiatAmount: 42.5,
  }, [
    { listing: listing("under", { fiatAmount: 42 }) },
    { listing: listing("over", { fiatAmount: 43 }) },
    { listing: listing("unpriced", { fiatAmount: undefined, fiatCurrency: undefined }) },
  ], { nowSec: NOW, limit: 10 });
  assert(
    limited.candidates.map(value => value.listing.id).join(",") === "under"
      && limited.rejected.some(value => value.listingId === "over" && value.code === "OVER_MAX_FIAT")
      && limited.rejected.some(value =>
        value.listingId === "unpriced" && value.code === "FIAT_QUOTE_REQUIRED"
      ),
    "enforces an exact-currency maximum without inventing missing fiat quotes",
  );

  const combined = matchGuidedListings({
    ...INTENT,
    amountSats: 50_000,
    fiatCurrency: "USD",
    maxFiatAmount: 42,
  }, [
    { listing: listing("exact-under", { amountMsats: 50_000_000, fiatAmount: 41 }) },
    { listing: listing("exact-over", { amountMsats: 50_000_000, fiatAmount: 43 }) },
    { listing: listing("wrong-sats-under", { amountMsats: 40_000_000, fiatAmount: 40 }) },
  ], { nowSec: NOW, limit: 10 });
  assert(
    combined.candidates.map(value => value.listing.id).join(",") === "exact-under"
      && combined.rejected.some(value =>
        value.listingId === "exact-over" && value.code === "OVER_MAX_FIAT"
      )
      && combined.rejected.some(value =>
        value.listingId === "wrong-sats-under" && value.code === "AMOUNT_MISMATCH"
      ),
    "intersects the exact-sats requirement with the maximum-fiat ceiling",
  );

  const ranked = matchGuidedListings(INTENT, [
    {
      listing: listing("cheap-new", { fiatAmount: 41 }),
      ratings: { count: 0, positive: 0, negative: 0 },
    },
    {
      listing: listing("trusted", { fiatAmount: 42 }),
      ratings: { count: 20, positive: 20, negative: 0 },
    },
    {
      listing: listing("expensive", { fiatAmount: 45 }),
      ratings: { count: 2, positive: 1, negative: 1 },
    },
  ], { nowSec: NOW, limit: 3 });
  assert(
    ranked.candidates.map(value => value.listing.id).join(",") === "trusted,cheap-new,expensive",
    "lets strong verified history outweigh a small price gap in best-overall ranking",
  );
  const cheapest = ranked.candidates.find(value => value.listing.id === "cheap-new");
  const trusted = ranked.candidates.find(value => value.listing.id === "trusted");
  assert(
    cheapest?.reasons.includes("lowest_fiat_quote")
      && trusted?.reasons.includes("positive_trade_history")
      && ranked.candidates.every(value =>
        value.score.total === Object.entries(value.score)
          .filter(([key]) => key !== "total")
          .reduce((sum, [, score]) => sum + score, 0)
      ),
    "returns human-explainable reasons and an auditable score breakdown",
  );
  const recommendations = recommendGuidedCandidates(ranked.candidates, "USD");
  assert(
    recommendations.bestOverall?.listing.id === "trusted"
      && recommendations.lowestPrice?.listing.id === "cheap-new"
      && recommendations.mostTrusted?.listing.id === "trusted",
    "derives Best Overall, Lowest Price, and Most Trusted independently",
  );

  const sell = matchGuidedListings({ ...INTENT, direction: "sell_sats" }, [
    { listing: eligible },
  ], { nowSec: NOW });
  assert(
    sell.candidates.length === 0 && sell.rejected[0]?.code === "UNSUPPORTED_DIRECTION",
    "does not pretend current seller listings can fulfill a sell-sats intent",
  );
}

console.log(`\nGuided results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
if (failed > 0) process.exit(1);
