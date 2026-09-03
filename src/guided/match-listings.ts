import {
  EscrowStatus,
  JOIN_HOLD_LOCK_GRACE_SECONDS,
  Role,
  type MenuItem,
  type SelectedMenuItem,
} from "../escrow-engine/types.js";
import type {
  GuidedListingInput,
  GuidedMatchCandidate,
  GuidedMatchOptions,
  GuidedRecommendations,
  GuidedMatchReason,
  GuidedMatchResult,
  GuidedMatchScore,
  GuidedRejectedListing,
  GuidedTradeIntent,
} from "./types.js";

const SCORE = {
  availability: 100,
  exactAmount: 150,
  rangedAmount: 100,
  paymentRail: 100,
  community: 75,
  federation: 75,
  price: 300,
  reputation: 200,
} as const;

type Eligible = Omit<GuidedMatchCandidate, "reasons" | "score"> & {
  amountReason: "exact_amount" | "amount_in_range";
};

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function rejection(listingId: string, code: GuidedRejectedListing["code"]): GuidedRejectedListing {
  return { listingId, code };
}

function fiatQuoteFor(item: MenuItem | undefined, listing: GuidedListingInput["listing"]):
  GuidedMatchCandidate["fiatQuote"] {
  const amount = item?.fiatAmount ?? listing.fiatAmount;
  const currency = item?.fiatCurrency ?? listing.fiatCurrency;
  if (
    typeof amount !== "number"
    || !Number.isFinite(amount)
    || amount <= 0
    || typeof currency !== "string"
    || !/^[A-Za-z]{3}$/.test(currency)
  ) return undefined;
  return { amount, currency: currency.toUpperCase() };
}

function matchingMenuItem(items: readonly MenuItem[], amountMsats: number): MenuItem | undefined {
  return items
    .filter(item => {
      if (item.kind === "bill") return item.amountMsats === amountMsats;
      if (item.kind !== "exchange-bracket") return false;
      const min = item.minAmountMsats ?? item.amountMsats;
      const max = item.maxAmountMsats ?? item.amountMsats;
      return amountMsats >= min && amountMsats <= max;
    })
    .sort((a, b) => {
      const aQuote = typeof a.fiatAmount === "number" && Number.isFinite(a.fiatAmount)
        ? a.fiatAmount
        : Number.POSITIVE_INFINITY;
      const bQuote = typeof b.fiatAmount === "number" && Number.isFinite(b.fiatAmount)
        ? b.fiatAmount
        : Number.POSITIVE_INFINITY;
      return aQuote - bQuote || a.id.localeCompare(b.id);
    })[0];
}

function selectedItemFor(item: MenuItem, amountMsats: number): SelectedMenuItem {
  return {
    itemId: item.id,
    label: item.label,
    amountMsats,
    quantity: 1,
    ...(item.kind ? { kind: item.kind } : {}),
    ...(item.minAmountMsats !== undefined ? { minAmountMsats: item.minAmountMsats } : {}),
    ...(item.maxAmountMsats !== undefined ? { maxAmountMsats: item.maxAmountMsats } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(item.fiatAmount !== undefined ? { fiatAmount: item.fiatAmount } : {}),
    ...(item.fiatCurrency ? { fiatCurrency: item.fiatCurrency } : {}),
    ...(item.fulfillment ? { fulfillment: item.fulfillment } : {}),
    ...(item.dueAt !== undefined ? { dueAt: item.dueAt } : {}),
    ...(item.termDays !== undefined ? { termDays: item.termDays } : {}),
    ...(item.aprBps !== undefined ? { aprBps: item.aprBps } : {}),
    ...(item.trustTier !== undefined ? { trustTier: item.trustTier } : {}),
  };
}

function reputationScore(ratings: Eligible["ratings"]): number {
  if (!ratings || ratings.count <= 0) return 0;
  const verifiedCount = Math.max(0, Math.min(ratings.count, ratings.positive + ratings.negative));
  if (verifiedCount <= 0) return 0;
  const positiveRatio = ratings.positive / verifiedCount;
  const confidence = Math.min(verifiedCount, 20) / 20;
  return Math.round(SCORE.reputation * positiveRatio * confidence);
}

function priceScores(eligible: readonly Eligible[]): Map<string, number> {
  const result = new Map<string, number>();
  const groups = new Map<string, Eligible[]>();
  for (const candidate of eligible) {
    if (!candidate.fiatQuote) continue;
    const group = groups.get(candidate.fiatQuote.currency) ?? [];
    group.push(candidate);
    groups.set(candidate.fiatQuote.currency, group);
  }
  for (const group of groups.values()) {
    const prices = group.map(candidate => candidate.fiatQuote!.amount);
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    for (const candidate of group) {
      const score = high === low
        ? SCORE.price
        : Math.round(SCORE.price * (high - candidate.fiatQuote!.amount) / (high - low));
      result.set(candidate.listing.id, score);
    }
  }
  return result;
}

function candidateScore(
  candidate: Eligible,
  intent: GuidedTradeIntent,
  price: number,
): GuidedMatchScore {
  const score: GuidedMatchScore = {
    availability: SCORE.availability,
    amountFit: candidate.amountReason === "exact_amount" ? SCORE.exactAmount : SCORE.rangedAmount,
    paymentRail: SCORE.paymentRail,
    community: intent.community ? SCORE.community : 0,
    federation: intent.mintUrl ? SCORE.federation : 0,
    price,
    reputation: reputationScore(candidate.ratings),
    total: 0,
  };
  score.total = score.availability
    + score.amountFit
    + score.paymentRail
    + score.community
    + score.federation
    + score.price
    + score.reputation;
  return score;
}

/** Pure, conservative matcher for today's seller-created cash-to-sats offers:
 * Exchange listings and community bill-pay listings.
 * It prepares no event, joins no seat, signs nothing, and moves no funds. */
export function matchGuidedListings(
  intent: GuidedTradeIntent,
  inputs: readonly GuidedListingInput[],
  options: GuidedMatchOptions = {},
): GuidedMatchResult {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const limit = Math.max(0, Math.min(options.limit ?? 3, 20));
  const eligible: Eligible[] = [];
  const rejected: GuidedRejectedListing[] = [];

  if (intent.direction !== "buy_sats") {
    return {
      candidates: [],
      rejected: inputs.map(({ listing }) => rejection(listing.id, "UNSUPPORTED_DIRECTION")),
    };
  }

  const amountMsats = intent.amountSats * 1000;
  for (const input of inputs) {
    const listing = input.listing;
    let code: GuidedRejectedListing["code"] | null = null;

    if (listing.category !== "p2p-trade" && listing.category !== "bill-pay") {
      code = "NOT_P2P_LISTING";
    }
    else if (listing.status !== EscrowStatus.CREATED) code = "NOT_OPEN";
    else if (listing.parent !== undefined) code = "CHILD_ORDER";
    else if ((listing.listingExpiresAt ?? listing.expiresAt) <= nowSec) code = "EXPIRED";
    else if (!listing.participants[Role.SELLER]) code = "NO_SELLER";
    else if (sameText(listing.participants[Role.SELLER], options.viewerPubkey)) code = "SELF_LISTING";
    else if (input.availableUnits !== undefined && input.availableUnits <= 0) code = "OUT_OF_STOCK";
    else {
      const hold = listing.joinHolds?.[Role.BUYER];
      if (
        hold
        && hold.expiresAt + JOIN_HOLD_LOCK_GRACE_SECONDS > nowSec
        && !sameText(hold.pubkey, options.viewerPubkey)
      ) code = "RESERVED";
    }
    if (!code && intent.community && !sameText(listing.community, intent.community)) {
      code = "COMMUNITY_MISMATCH";
    }
    if (!code && intent.mintUrl && listing.mintUrl !== intent.mintUrl) {
      code = "FEDERATION_MISMATCH";
    }

    const listingRails = [...new Set(
      (listing.paymentMethods ?? []).map(rail => rail.trim().toLowerCase()).filter(Boolean),
    )];
    const paymentRail = intent.paymentRails.find(rail => listingRails.includes(rail));
    if (!code && !paymentRail) code = "PAYMENT_RAIL_MISMATCH";

    let sourceMenuItem: MenuItem | undefined;
    let amountReason: Eligible["amountReason"] = "exact_amount";
    if (!code && listing.items?.length) {
      sourceMenuItem = matchingMenuItem(listing.items, amountMsats);
      if (!sourceMenuItem) code = "AMOUNT_MISMATCH";
      else {
        const min = sourceMenuItem.minAmountMsats ?? sourceMenuItem.amountMsats;
        const max = sourceMenuItem.maxAmountMsats ?? sourceMenuItem.amountMsats;
        amountReason = min === amountMsats && max === amountMsats
          ? "exact_amount"
          : "amount_in_range";
      }
    } else if (!code && listing.amountMsats !== amountMsats) {
      code = "AMOUNT_MISMATCH";
    }

    const fiatQuote = fiatQuoteFor(sourceMenuItem, listing);
    if (!code && intent.maxFiatAmount !== undefined) {
      if (!fiatQuote) code = "FIAT_QUOTE_REQUIRED";
      else if (fiatQuote.currency !== intent.fiatCurrency) code = "FIAT_CURRENCY_MISMATCH";
      else if (fiatQuote.amount > intent.maxFiatAmount) code = "OVER_MAX_FIAT";
    }

    if (code) {
      rejected.push(rejection(listing.id, code));
      continue;
    }

    const sellerPubkey = listing.participants[Role.SELLER]!;
    eligible.push({
      listing,
      sellerPubkey,
      amountSats: intent.amountSats,
      paymentRail: paymentRail!,
      ...(sourceMenuItem ? {
        sourceMenuItem,
        selectedItem: selectedItemFor(sourceMenuItem, amountMsats),
      } : {}),
      ...(fiatQuote ? { fiatQuote } : {}),
      advertisedFeesMsats: {
        platform: listing.fees.platformMsats,
        arbiter: listing.fees.arbiterMsats,
        total: listing.fees.platformMsats + listing.fees.arbiterMsats,
      },
      ...(input.ratings ? { ratings: input.ratings } : {}),
      amountReason,
    });
  }

  const prices = priceScores(eligible);
  const candidates = eligible.map(candidate => {
    const score = candidateScore(candidate, intent, prices.get(candidate.listing.id) ?? 0);
    const reasons: GuidedMatchReason[] = [
      "available_now",
      candidate.amountReason,
      "compatible_payment_rail",
    ];
    if (intent.community) reasons.push("same_community");
    if (intent.mintUrl) reasons.push("same_federation");
    if (score.price === SCORE.price && candidate.fiatQuote) reasons.push("lowest_fiat_quote");
    if (score.reputation > 0) reasons.push("positive_trade_history");
    const { amountReason: _amountReason, ...publicCandidate } = candidate;
    return { ...publicCandidate, reasons, score };
  }).sort((a, b) =>
    b.score.total - a.score.total
    || (a.fiatQuote?.amount ?? Number.POSITIVE_INFINITY)
      - (b.fiatQuote?.amount ?? Number.POSITIVE_INFINITY)
    || a.listing.id.localeCompare(b.listing.id)
  );

  return { candidates: candidates.slice(0, limit), rejected };
}

/** Derive human-readable recommendation lanes without manufacturing weaker
 * alternatives. Lowest price only compares like currencies; Most Trusted
 * requires verified completed-trade ratings supplied by the caller. */
export function recommendGuidedCandidates(
  candidates: readonly GuidedMatchCandidate[],
  fiatCurrency?: string,
): GuidedRecommendations {
  const bestOverall = candidates[0] ?? null;
  const currency = fiatCurrency?.toUpperCase()
    ?? bestOverall?.fiatQuote?.currency
    ?? candidates.find(candidate => candidate.fiatQuote)?.fiatQuote?.currency;
  const priced = currency
    ? candidates.filter(candidate => candidate.fiatQuote?.currency === currency)
    : [];
  const lowestPrice = [...priced].sort((a, b) =>
    a.fiatQuote!.amount - b.fiatQuote!.amount
    || b.score.total - a.score.total
    || a.listing.id.localeCompare(b.listing.id)
  )[0] ?? null;
  const trusted = candidates.filter(candidate =>
    candidate.ratings
    && candidate.ratings.count > 0
    && candidate.ratings.positive + candidate.ratings.negative > 0
  );
  const mostTrusted = [...trusted].sort((a, b) => {
    const aCount = Math.min(a.ratings!.count, a.ratings!.positive + a.ratings!.negative);
    const bCount = Math.min(b.ratings!.count, b.ratings!.positive + b.ratings!.negative);
    const aRatio = aCount > 0 ? a.ratings!.positive / aCount : 0;
    const bRatio = bCount > 0 ? b.ratings!.positive / bCount : 0;
    return bRatio - aRatio
      || bCount - aCount
      || b.score.total - a.score.total
      || a.listing.id.localeCompare(b.listing.id);
  })[0] ?? null;
  return { bestOverall, lowestPrice, mostTrusted };
}
