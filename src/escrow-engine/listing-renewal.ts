// ══════════════════════════════════════════════════════════════════════════
// Chama — Store permanence (#49) Tier 1 + Tier 3: renewable listings
// ══════════════════════════════════════════════════════════════════════════
//
// A Stores listing today dies at settle or at its `expirySeconds` lapse
// (default 24h). A seller who finishes one trade and turns to the next may
// find the shopfront already gone. Store permanence keeps the store alive
// WITHOUT ever letting a locked trade's funds sit longer — because
// `expirySeconds` double-books as the LOCKED-trade timeout
// (state-machine.ts: `expiresAt = lockedAt + tradeTimeoutSeconds`,
// `tradeTimeoutSeconds = expirySeconds`). So permanence is delivered by
// RE-PUBLISHING a fresh CREATE (new 24h window) when the OLD one lapsed
// UNFUNDED — never by extending the timeout of a fundable/locked listing.
//
// This module is PURE: no relays, no money, no reducer/consensus touch. It
// only decides (a) which of the user's own listings are renewable, and (b)
// how to rebuild the CREATE params for the re-publish. The escrow hook wires
// the actual `createEscrow` re-publish; App wires the online-gated auto-renew
// and the manual "your store lapsed — renew?" card.
//
// Tier 3 (bond-gated tenure): a chain-verified bonded seller (funded + active
// 38135 ≥ a floor) gets AUTO-RENEW (the store persists while they're online)
// and a longer store horizon; an unbonded seller gets the 24h default with
// MANUAL renew only. The bond is a "storefront license" — symmetry with the
// arbiter "earnings license". Crucially the bond buys auto-renew + horizon, it
// does NOT buy a longer lock: every re-published CREATE keeps the same short
// (24h) expiry, so an individual locked trade always times out at ~24h.

import { EscrowStatus, Role, type EscrowState, type WorkListingKind } from "./types.js";
import type { VerifiedBond } from "../bond-multisig/bond-announcement.js";
import type { CommitmentRecord } from "../bond-multisig/commitment-store.js";

/** Case-insensitive hex-pubkey compare (per-file helper convention). */
function samePubkey(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** How early (seconds before lapse) auto-renew re-publishes an about-to-lapse
 *  listing. Wide enough that a client polling every few minutes catches the
 *  window; small relative to the 24h life. Manual renew has no lead — it only
 *  offers once fully lapsed. */
export const RENEW_LEAD_SECONDS = 15 * 60;

/** Store horizons (display / liveness bound, NOT the trade timeout). Unbonded
 *  = a single 24h window (manual renew only). Bonded = a 7-day rolling tenure
 *  the store keeps auto-renewing into while the seller is online. */
export const UNBONDED_TENURE_SECONDS = 24 * 60 * 60;
export const BONDED_TENURE_SECONDS = 7 * 24 * 60 * 60;

/** Bond floor (sats) for the storefront-license gate. Mirrors
 *  `UNBONDED_FLOOR_MSATS` (10,000,000 msats = 10,000 sats) in arbiters/exposure
 *  — re-declared locally to keep this pure escrow-engine module free of an
 *  arbiters import cycle. */
export const LISTING_BOND_FLOOR_SATS = 10_000n;

/** ⭐ A2 merchant floor (Jetty, 2026-07-28). A shopkeeper who wants painless
 *  renewal should not have to become a judge, so a bond may declare itself
 *  `merchant` (A0, kind 38135 `roles`) and stay out of the arbiter pool. Since
 *  that bond's job is Sybil cost on renewal rather than dispute capacity, it
 *  never needs to cover a trade — hence a lower floor.
 *
 *  ⚠ These two floors must NEVER be collapsed into one constant. A 2,500-sat
 *  merchant bond satisfying an arbiter capacity check would seat a judge with a
 *  quarter of the required stake. They are separate on purpose. */
export const MERCHANT_BOND_FLOOR_SATS = 2_500n;
/** A broadcast rollover may bridge store renewal only while the replacement is
 * awaiting its first confirmation. This grace never enters bond verification,
 * arbiter assignment, ratings, or liveness. */
export const STORE_ROLLOVER_GRACE_MS = 24 * 60 * 60 * 1000;

export function hasPendingStoreRollover(
  records: readonly CommitmentRecord[],
  tip: number | null,
  nowMs: number = Date.now(),
): boolean {
  if (tip == null) return false;
  const byId = new Map(records.map((r) => [r.bondId, r]));
  return records.some((next) => {
    if (next.phase !== "created" || !next.renewedFromBondId || !next.renewalTxid || !next.renewalBroadcastAt) return false;
    if (next.amountSats < LISTING_BOND_FLOOR_SATS || nowMs - next.renewalBroadcastAt > STORE_ROLLOVER_GRACE_MS) return false;
    const old = byId.get(next.renewedFromBondId);
    return !!old && old.phase === "locked" && old.renewalToBondId === next.bondId && old.renewalTxid === next.renewalTxid && tip >= old.bond.lockUntil;
  });
}

/** True when `npub` holds a chain-verified, funded, still-active 38135 bond at
 *  or above the storefront-license floor. Drives Tier 3 tenure. */
export function sellerIsBonded(bonds: readonly VerifiedBond[], npub: string | null): boolean {
  if (!npub) return false;
  return bonds.some((b) => {
    if (!b.funded || !b.active || !samePubkey(b.npub, npub)) return false;
    // A bond that opted OUT of arbitration is a storefront license, and clears
    // the lower merchant floor. A bond that is (also) an arbiter bond is held to
    // the full arbiter floor — it buys strictly more, so it costs more.
    // Absent `roles` ⇒ arbiter (every pre-A0 bond), so this is byte-identical
    // for every bond announced before the merchant lane existed.
    const merchantOnly = !!b.roles && b.roles.length > 0 && !b.roles.includes("arbiter");
    const floor = merchantOnly ? MERCHANT_BOND_FLOOR_SATS : LISTING_BOND_FLOOR_SATS;
    return b.actualSats >= floor;
  });
}

/** The resolved tenure policy for a listing, given the seller's bond status.
 *  `expirySeconds` is intentionally absent: renewal never stamps a longer
 *  expiry (that would extend the locked-trade timeout) — it lets the CREATE
 *  path apply the same short default a fresh publish uses. */
export interface ListingTenure {
  /** Whether the client should auto-renew this store while the seller is
   *  online (bonded) vs. offer manual renew only (unbonded). */
  autoRenew: boolean;
  /** The store horizon for copy / liveness (NOT the trade timeout). */
  maxTenureSeconds: number;
  /** Echo of the gate input, for UI copy. */
  bonded: boolean;
}

/** Resolve Tier 3 tenure from the bond gate. Pure branch — the ONLY thing the
 *  bond changes is auto-renew + the store horizon; the trade timeout is
 *  untouched (permanence via renewal, never via longer locks). */
export function resolveListingTenure(opts: { bonded: boolean }): ListingTenure {
  return {
    autoRenew: opts.bonded,
    maxTenureSeconds: opts.bonded ? BONDED_TENURE_SECONDS : UNBONDED_TENURE_SECONDS,
    bonded: opts.bonded,
  };
}

/** True when the listing belongs to `userPubkey` as its SELLER — the only
 *  party allowed to renew. A CHILD order (a buyer's purchase from a multi-unit
 *  parent) is never a renewable storefront, so it's excluded. */
export function isSellerOwnedListing(state: EscrowState, userPubkey: string | null): boolean {
  if (!userPubkey) return false;
  if (state.parent !== undefined) return false; // a child order is not a storefront
  return (
    samePubkey(state.participants[Role.SELLER], userPubkey) ||
    (state.initiator?.role === Role.SELLER && samePubkey(state.initiator.pubkey, userPubkey))
  );
}

/** True when the listing LAPSED UNFUNDED — it was never LOCKED (lock fields
 *  stay null until a LOCK lands) and it's in a browse-listing state that can be
 *  re-published. CANCELLED (seller deleted it on purpose) and any funded /
 *  settled trade are excluded — we never resurrect those. */
export function listingNeverFunded(state: EscrowState): boolean {
  return (
    state.lock.lockedAt === null &&
    state.lock.notesHash === null &&
    (state.status === EscrowStatus.CREATED || state.status === EscrowStatus.EXPIRED)
  );
}

/** True once the listing's active deadline has passed. */
export function listingHasLapsed(state: EscrowState, nowSec: number): boolean {
  return nowSec >= state.expiresAt;
}

// ══════════════════════════════════════════════════════════════════════════
// A2 (2026-07-28) — PER-VERTICAL RENEWAL POLICY
// ══════════════════════════════════════════════════════════════════════════
//
// Renewal used to belong to Stores alone, with a comment promising that "other
// verticals have their own explicit recurrence decisions". This is that
// decision. Brief: design/mockups/chama-listing-renewal-policy-brief.md.
//
// ⭐ WHY THE OTHER LANES NEED NO BOND. Renewal is only spam if renewals
// ACCUMULATE. They cannot here: `listingIdentityKey` + `supersededListingIds`
// (listing-renewal-ledger.ts) already enforce one live listing per identical
// offer, and the durable retired ledger makes that survive a reload — the
// machinery the clone-war fix paid for. Under that rule a want-ad that can only
// ever exist once per author is a standing statement, not a broadcast.
//
// Stores keep the bond gate because that is the one lane where the identity
// rule is weakest: product listings are open-ended and high-cardinality, so a
// seller can mint genuinely-distinct offers all day. Everywhere else the offer
// IS the person's standing intent, and there is only one of them.
//
// ⚠ UNCHANGED AND UNCHANGEABLE: renewal never extends a LOCKED trade's timeout.
// `expirySeconds` double-books as the trade timeout, so every re-published
// CREATE keeps the same short window. A "30-day horizon" means thirty renewals
// of a 24h listing, never one 30-day lock.

/** Which recurrence rules a listing falls under. */
export type RenewalLane =
  /** Marketplace storefronts. Bond-gated auto-renew (the storefront license). */
  | "store"
  /** Work, either side. A person's skills — or a client's need — are durable
   *  facts, and matching only works if BOTH sides can wait. */
  | "work"
  /** Community bill pay. A bill is a recurring real-world obligation. */
  | "bill"
  /** Exchange. Already bounded by curated brackets, so the identity space is
   *  small and the dedupe is tight. */
  | "exchange"
  /** Not a renewable listing (child orders, lending, anything unrecognized). */
  | "none";

export interface RenewalPolicy {
  lane: RenewalLane;
  /** May this listing be re-published at all (manually or automatically)? */
  renewable: boolean;
  /** Should the online effect re-publish it hands-free? */
  autoRenew: boolean;
  /** Does hands-free renewal require a funded bond (Stores only)? */
  requiresBond: boolean;
  /** Display/liveness horizon in seconds. NOT the trade timeout. */
  maxTenureSeconds: number;
  /** How many hands-free cycles before the age-out backstop retires an offer
   *  nobody has shown interest in. Derived from the horizon, because a 30-day
   *  lane renewing a 24h listing needs ~30 cycles — the Stores-era cap of 7
   *  would have quietly killed every Work offer after a week. */
  maxAutoRenewCycles: number;
}

/** Rolling horizons per lane. Tunable product knobs, not logic. */
export const WORK_TENURE_SECONDS = 30 * 24 * 60 * 60;
export const BILL_TENURE_SECONDS = 30 * 24 * 60 * 60;
export const EXCHANGE_TENURE_SECONDS = 7 * 24 * 60 * 60;

/** The renewal window a listing is re-published into (the CREATE default). Used
 *  to convert a lane's horizon into a cycle count. */
const RENEWAL_WINDOW_SECONDS = 24 * 60 * 60;

function cyclesFor(tenureSeconds: number): number {
  return Math.max(1, Math.round(tenureSeconds / RENEWAL_WINDOW_SECONDS));
}

/** Which lane a listing belongs to. Pure; a child order is never renewable. */
export function renewalLaneFor(state: EscrowState): RenewalLane {
  if (state.parent !== undefined) return "none";
  // Work rides marketplace escrow routing for compatibility, so it must be
  // checked BEFORE the storefront branch or it would inherit Store policy —
  // the exact confusion the old comment warned about.
  if (state.listingKind === "work" || state.listingKind === "work-request") return "work";
  if (state.category === "marketplace") return "store";
  if (state.category === "bill-pay") return "bill";
  if (state.category === "p2p-trade") return "exchange";
  // Lending is retired from Create and Chip In is not a category yet. Both stay
  // out until they have an explicit decision of their own.
  return "none";
}

/** ⭐ The policy table. `bonded` only matters to the store lane. */
export function resolveRenewalPolicy(
  state: EscrowState,
  opts: { bonded: boolean } = { bonded: false },
): RenewalPolicy {
  const lane = renewalLaneFor(state);
  switch (lane) {
    case "work":
      return {
        lane, renewable: true, autoRenew: true, requiresBond: false,
        maxTenureSeconds: WORK_TENURE_SECONDS,
        maxAutoRenewCycles: cyclesFor(WORK_TENURE_SECONDS),
      };
    case "bill":
      return {
        lane, renewable: true, autoRenew: true, requiresBond: false,
        maxTenureSeconds: BILL_TENURE_SECONDS,
        maxAutoRenewCycles: cyclesFor(BILL_TENURE_SECONDS),
      };
    case "exchange":
      return {
        lane, renewable: true, autoRenew: true, requiresBond: false,
        maxTenureSeconds: EXCHANGE_TENURE_SECONDS,
        maxAutoRenewCycles: cyclesFor(EXCHANGE_TENURE_SECONDS),
      };
    case "store": {
      // Unchanged from Tier 3: the bond buys auto-renew + the longer horizon,
      // never a longer lock. Unbonded stores keep 24h + manual renew.
      const tenure = resolveListingTenure({ bonded: opts.bonded });
      return {
        lane, renewable: true, autoRenew: tenure.autoRenew, requiresBond: true,
        maxTenureSeconds: tenure.maxTenureSeconds,
        maxAutoRenewCycles: cyclesFor(tenure.maxTenureSeconds),
      };
    }
    default:
      return {
        lane: "none", renewable: false, autoRenew: false, requiresBond: false,
        maxTenureSeconds: 0, maxAutoRenewCycles: 0,
      };
  }
}

/** Store-permanence belongs only to the Market storefront vertical. Retained
 *  for callers that specifically mean STOREFRONT; renewal eligibility now goes
 *  through `resolveRenewalPolicy`. */
export function isRenewableStorefront(state: EscrowState): boolean {
  return renewalLaneFor(state) === "store";
}

/** Auto-renew eligibility: the seller's own unfunded listing that has lapsed OR
 *  is within the lead window. Never a funded/locked/settled/cancelled trade, and
 *  never an id already RETIRED (superseded by a prior renewal — the durable
 *  cross-reload guard that stops the +N-per-open duplication). `retired` defaults
 *  empty so existing callers are byte-identical. */
export function canRenewListing(
  state: EscrowState,
  userPubkey: string | null,
  nowSec: number,
  retired: ReadonlySet<string> = EMPTY_RETIRED,
  /** A2: bond status, which only the STORE lane consults. Defaults to false so
   *  an existing caller keeps today's behaviour exactly — an unbonded store is
   *  manual-renew-only, as it has always been. */
  opts: { bonded: boolean } = { bonded: false },
): boolean {
  const policy = resolveRenewalPolicy(state, opts);
  return (
    !retired.has(state.id) &&
    policy.autoRenew &&
    isSellerOwnedListing(state, userPubkey) &&
    listingNeverFunded(state) &&
    nowSec >= state.expiresAt - RENEW_LEAD_SECONDS
  );
}

/** Shared empty default so the retired param stays backward-compatible. */
const EMPTY_RETIRED: ReadonlySet<string> = new Set<string>();

/** ⚠ MANUAL renew eligibility — deliberately distinct from `canRenewListing`.
 *
 *  `canRenewListing` answers "should the effect re-publish this hands-free",
 *  which for a store depends on a bond. This answers "may the seller re-list
 *  their own lapsed offer", which never does. Collapsing the two would take the
 *  manual Renew button away from every unbonded storefront — a right they have
 *  always had, and the whole reason the unbonded tier exists. */
export function canManuallyRenewListing(
  state: EscrowState,
  userPubkey: string | null,
  nowSec: number,
  retired: ReadonlySet<string> = EMPTY_RETIRED,
): boolean {
  return (
    !retired.has(state.id) &&
    resolveRenewalPolicy(state).renewable &&
    isSellerOwnedListing(state, userPubkey) &&
    listingNeverFunded(state) &&
    nowSec >= state.expiresAt - RENEW_LEAD_SECONDS
  );
}

/** Fully-lapsed unfunded listings the seller owns — the manual "your store
 *  lapsed — renew?" card feeds off this (no lead window; only truly-lapsed).
 *  Retired ids are excluded so a superseded listing never re-offers the card. */
export function lapsedRenewableListings(
  states: Iterable<EscrowState>,
  userPubkey: string | null,
  nowSec: number,
  retired: ReadonlySet<string> = EMPTY_RETIRED,
): EscrowState[] {
  const out: EscrowState[] = [];
  for (const s of states) {
    if (
      !retired.has(s.id) &&
      // MANUAL renew is offered for every renewable lane regardless of bond —
      // the bond gates hands-free renewal, never the seller's own right to
      // re-list something that lapsed.
      resolveRenewalPolicy(s).renewable &&
      isSellerOwnedListing(s, userPubkey) &&
      listingNeverFunded(s) &&
      listingHasLapsed(s, nowSec)
    ) {
      out.push(s);
    }
  }
  return out;
}

/** Whether a lapsed listing belongs in the Me reminder right now. Storefront
 * reminders are a bonded-seller surface: old stores stay dormant while the
 * bond is inactive, automatically return with the verified bond, and may be
 * snoozed locally. Other renewal lanes retain their existing visibility. */
export function lapsedRenewalReminderVisible(
  state: EscrowState,
  opts: { bonded: boolean; snoozedUntilMs?: number; nowMs: number },
): boolean {
  if (renewalLaneFor(state) !== "store") return true;
  return opts.bonded && opts.nowMs >= (opts.snoozedUntilMs ?? 0);
}

/** Every one of the user's OWN never-funded listings (any status short of a
 *  funded/locked/settled trade), excluding already-retired ids. Feeds the
 *  "Clear my unfunded listings" action — a one-tap retire of the seller's whole
 *  wall of stale/abandoned/test offers. Does NOT touch funded trades. */
export function ownUnfundedListings(
  states: Iterable<EscrowState>,
  userPubkey: string | null,
  retired: ReadonlySet<string> = EMPTY_RETIRED,
): EscrowState[] {
  const out: EscrowState[] = [];
  for (const s of states) {
    if (!retired.has(s.id) && isSellerOwnedListing(s, userPubkey) && listingNeverFunded(s)) {
      out.push(s);
    }
  }
  return out;
}

/** Listings the online auto-renew effect should re-publish now (lapsed or
 *  about-to-lapse, seller-owned, unfunded, not already retired). */
export function autoRenewableListings(
  states: Iterable<EscrowState>,
  userPubkey: string | null,
  nowSec: number,
  retired: ReadonlySet<string> = EMPTY_RETIRED,
  opts: { bonded: boolean } = { bonded: false },
): EscrowState[] {
  const out: EscrowState[] = [];
  for (const s of states) {
    if (canRenewListing(s, userPubkey, nowSec, retired, opts)) out.push(s);
  }
  return out;
}

/** Params for the re-published CREATE — a structural subset of
 *  EscrowClient.createEscrow's params rebuilt from a lapsed listing's state.
 *  Deliberately carries NO `expirySeconds`: the CREATE path applies the same
 *  short default a fresh publish uses, so the renewed store's timeout stays
 *  ~24h. No `parent`/`claimedQuantity` (a storefront is never a child). */
export interface RenewCreateParams {
  description: string;
  listingKind?: WorkListingKind;
  imageDataUrl?: string;
  imageUrls?: string[];
  amountMsats: number;
  fiatAmount?: number;
  fiatCurrency?: string;
  premiumBps?: number;
  category: string;
  fulfillment?: "physical" | "service" | "digital";
  community?: string;
  country?: string;
  billType?: string;
  workCategory?: string;
  mintUrl: string;
  paymentMethods?: string[];
  arbiterFeeMsats?: number;
  communityArbiters?: string[];
  bondedArbiters?: string[];
  items?: EscrowState["items"];
  stock?: number;
  subscription?: {
    totalPeriods: number;
    periodAmountMsats: number;
    periodDurationSeconds: number;
  };
}

/** Rebuild the CREATE params for an identical re-publish of a lapsed listing.
 *  Pure; throws only on a structural misuse (renewing a child order). Money
 *  safety is unaffected — this just re-lists a browse offer. */
export function buildRenewCreateParams(state: EscrowState): RenewCreateParams {
  if (state.parent !== undefined) {
    throw new Error("buildRenewCreateParams: a child order is not a renewable listing");
  }
  return {
    description: state.description,
    ...(state.listingKind ? { listingKind: state.listingKind } : {}),
    ...(state.imageDataUrl ? { imageDataUrl: state.imageDataUrl } : {}),
    ...(state.imageUrls?.length ? { imageUrls: [...state.imageUrls] } : {}),
    amountMsats: state.amountMsats,
    ...(state.fiatAmount !== undefined ? { fiatAmount: state.fiatAmount } : {}),
    ...(state.fiatCurrency !== undefined ? { fiatCurrency: state.fiatCurrency } : {}),
    ...(state.premiumBps !== undefined ? { premiumBps: state.premiumBps } : {}),
    category: state.category,
    fulfillment: state.fulfillment,
    ...(state.community ? { community: state.community } : {}),
    ...(state.country ? { country: state.country } : {}),
    ...(state.billType ? { billType: state.billType } : {}),
    ...(state.workCategory ? { workCategory: state.workCategory } : {}),
    mintUrl: state.mintUrl,
    ...(state.paymentMethods ? { paymentMethods: state.paymentMethods } : {}),
    arbiterFeeMsats: state.fees.arbiterMsats,
    ...(state.communityArbiters.length > 0 ? { communityArbiters: state.communityArbiters } : {}),
    ...(state.bondedArbiters && state.bondedArbiters.length > 0
      ? { bondedArbiters: state.bondedArbiters }
      : {}),
    ...(state.items ? { items: state.items } : {}),
    ...(state.stock !== undefined ? { stock: state.stock } : {}),
    ...(state.subscription
      ? {
          subscription: {
            totalPeriods: state.subscription.totalPeriods,
            periodAmountMsats: state.subscription.periodAmountMsats,
            periodDurationSeconds: state.subscription.periodDurationSeconds,
          },
        }
      : {}),
  };
}
