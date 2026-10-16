import type {
  AggregateRatings,
} from "../reputation/ratings.js";
import type {
  EscrowState,
  MenuItem,
  SelectedMenuItem,
} from "../escrow-engine/types.js";

/** Language-neutral contract produced by buttons, text, or future voice input.
 * v1 deliberately describes intent only; it cannot authorize or execute money
 * movement. */
export interface GuidedTradeIntent {
  version: 1;
  direction: "buy_sats" | "sell_sats";
  amountSats: number;
  paymentRails: string[];
  strategy: "available_now";
  community?: string;
  mintUrl?: string;
  fiatCurrency?: string;
  maxFiatAmount?: number;
}

export type GuidedIntentField =
  | "$"
  | "version"
  | "direction"
  | "amountSats"
  | "paymentRails"
  | "strategy"
  | "community"
  | "mintUrl"
  | "fiatCurrency"
  | "maxFiatAmount";

export type GuidedIntentValidationCode =
  | "NOT_AN_OBJECT"
  | "UNKNOWN_FIELD"
  | "UNSUPPORTED_VERSION"
  | "INVALID_DIRECTION"
  | "INVALID_AMOUNT"
  | "INVALID_PAYMENT_RAILS"
  | "INVALID_STRATEGY"
  | "INVALID_COMMUNITY"
  | "INVALID_MINT_URL"
  | "INCOMPLETE_FIAT_LIMIT"
  | "INVALID_FIAT_CURRENCY"
  | "INVALID_MAX_FIAT";

export interface GuidedIntentValidationIssue {
  field: GuidedIntentField;
  code: GuidedIntentValidationCode;
  message: string;
}

export type GuidedIntentValidationResult =
  | { ok: true; value: GuidedTradeIntent }
  | { ok: false; issues: GuidedIntentValidationIssue[] };

/** Optional facts already known by the caller. The matcher performs no relay,
 * reputation, stock, or wallet reads itself. */
export interface GuidedListingInput {
  listing: EscrowState;
  ratings?: AggregateRatings;
  /** Derived by the existing storefront accountant when applicable. Omit for
   * legacy single-offer listings. */
  availableUnits?: number;
}

export type GuidedMatchRejectionCode =
  | "UNSUPPORTED_DIRECTION"
  | "NOT_P2P_LISTING"
  | "NOT_OPEN"
  | "CHILD_ORDER"
  | "EXPIRED"
  | "SELF_LISTING"
  | "NO_ARBITER_POOL"
  | "NO_SELLER"
  | "RESERVED"
  | "OUT_OF_STOCK"
  | "COMMUNITY_MISMATCH"
  | "FEDERATION_MISMATCH"
  | "PAYMENT_RAIL_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "FIAT_QUOTE_REQUIRED"
  | "FIAT_CURRENCY_MISMATCH"
  | "OVER_MAX_FIAT";

export interface GuidedRejectedListing {
  listingId: string;
  code: GuidedMatchRejectionCode;
}

export type GuidedMatchReason =
  | "available_now"
  | "exact_amount"
  | "amount_in_range"
  | "compatible_payment_rail"
  | "same_community"
  | "same_federation"
  | "lowest_fiat_quote"
  | "positive_trade_history";

export interface GuidedMatchScore {
  availability: number;
  amountFit: number;
  paymentRail: number;
  community: number;
  federation: number;
  price: number;
  reputation: number;
  total: number;
}

export interface GuidedMatchCandidate {
  listing: EscrowState;
  sellerPubkey: string;
  amountSats: number;
  paymentRail: string;
  selectedItem?: SelectedMenuItem;
  sourceMenuItem?: MenuItem;
  fiatQuote?: {
    amount: number;
    currency: string;
  };
  advertisedFeesMsats: {
    platform: number;
    arbiter: number;
    total: number;
  };
  ratings?: AggregateRatings;
  reasons: GuidedMatchReason[];
  score: GuidedMatchScore;
}

export interface GuidedMatchOptions {
  nowSec?: number;
  viewerPubkey?: string | null;
  limit?: number;
}

export interface GuidedMatchResult {
  candidates: GuidedMatchCandidate[];
  rejected: GuidedRejectedListing[];
}

/** Named comparison lanes. The same candidate may honestly win more than one. */
export interface GuidedRecommendations {
  bestOverall: GuidedMatchCandidate | null;
  lowestPrice: GuidedMatchCandidate | null;
  mostTrusted: GuidedMatchCandidate | null;
}
