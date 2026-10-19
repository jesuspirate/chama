// ══════════════════════════════════════════════════════════════════════════
// #7 multi-unit storefront — pure stock accounting (Stage 2a)
// ══════════════════════════════════════════════════════════════════════════
//
// A multi-unit PARENT listing offers `stock` units. Each buyer's purchase is a
// CHILD escrow (carrying `parent` = the parent's id and `claimedQuantity`).
// Remaining stock is DERIVED — never stored — from the parent's children.
// These functions are pure and the testable heart of the storefront: no
// relays, no UI, no money. Money only ever lives in each child's own 2-of-3
// escrow, so a wrong count is at worst a display glitch, never a loss — which
// is what makes the optimistic (overcommit → refund) race policy acceptable
// under eventual consistency.
//
// Two distinct notions, deliberately separate:
//   • availableStock — units a NEW buyer can take RIGHT NOW (held + locked
//     units both subtracted). Drives "N available" and whether a fresh buyer
//     can join.
//   • unsoldStock — units not yet LOCKED (held units still count). A listing
//     stays browsable while unsold > 0; it's "sold out" only when every unit
//     is locked. The last-unit contention countdown keys off this: the last
//     unsold unit being held is exactly the "1 left, being viewed" case.

import {
  EscrowStatus,
  Role,
  JOIN_HOLD_LOCK_GRACE_SECONDS,
  type EscrowState,
} from "./types.js";

/** A child whose sats are locked or already settled — the unit is sold and
 *  only frees again via a refund (which moves it to CANCELLED / EXPIRED). */
function childIsLocked(child: EscrowState): boolean {
  return (
    child.status === EscrowStatus.LOCKED ||
    child.status === EscrowStatus.APPROVED ||
    child.status === EscrowStatus.CLAIMED ||
    child.status === EscrowStatus.COMPLETED
  );
}

/** A CREATED child with a live buyer reservation (hold not past its expiry +
 *  the hidden lock-grace window). The grace is included on purpose: a hold
 *  inside grace can still produce a LOCK, so we keep the unit reserved rather
 *  than briefly reselling it. */
function childIsHeld(child: EscrowState, now: number): boolean {
  if (child.status !== EscrowStatus.CREATED) return false;
  const hold = child.joinHolds?.[Role.BUYER];
  return !!hold && hold.expiresAt + JOIN_HOLD_LOCK_GRACE_SECONDS > now;
}

/** True when a child's claimed units currently count against availability
 *  (locked OR actively held). Cancelled / expired / lapsed-hold children free
 *  their units back. */
export function childCommitsStock(child: EscrowState, now: number): boolean {
  return childIsLocked(child) || childIsHeld(child, now);
}

/** #63 storefront-vs-order clarity. A PARENT storefront is a multi-unit listing
 *  (`stock` set) that is not itself a child — the persistent shopfront that
 *  spawns child order escrows on each purchase. Pure display predicate. */
export function isParentStorefront(s: EscrowState): boolean {
  return s.stock !== undefined && s.parent === undefined;
}

/** #63 A CHILD order is one purchase spawned from a parent storefront — it
 *  carries `parent` = the storefront's id. Pure display predicate. */
export function isChildOrder(s: EscrowState): boolean {
  return s.parent !== undefined;
}

/** #63 A child order that is LIVE for the seller to act on: funded (LOCKED)
 *  but not yet settled. Drives the "orders in progress" list on the storefront
 *  and the new-order notification. */
export function isLiveChildOrder(s: EscrowState): boolean {
  return isChildOrder(s) && s.status === EscrowStatus.LOCKED;
}

/** #70 A CHILD order that is still LIVE for the seller — any non-terminal child
 *  (joined/CREATED, LOCKED, or mid-settlement APPROVED/CLAIMED). Broader than
 *  isLiveChildOrder (LOCKED-only) on purpose: every open order can carry unread
 *  chat + attention the seller must see, so the parent storefront can aggregate
 *  ALL of them, not just the one funded order. Pure display predicate. */
export function isActiveChildOrder(s: EscrowState): boolean {
  return (
    isChildOrder(s) &&
    s.status !== EscrowStatus.COMPLETED &&
    s.status !== EscrowStatus.CANCELLED &&
    s.status !== EscrowStatus.EXPIRED
  );
}

/** Audit M3: a storefront purchase is written and signed by the BUYER, so its
 *  terms are only the buyer's word. Before a child counts as an order (or
 *  against stock) its money terms must be the listing's: the listing's seller,
 *  federation and arbiter list, and the listing's price times the units
 *  claimed. Returns what differs; empty means it matches. Circle shares and
 *  tranche children have their own checks and are never judged here. A pure
 *  reader check: no event, reducer or replay changes. */
export function storefrontChildMismatches(parent: EscrowState, child: EscrowState): string[] {
  if (child.parent !== parent.id) return [];
  // Exempt only where the parent really is a circle or a tranche plan; on a
  // storefront those markers are just more buyer-written fields.
  if ((child.chamaPolicy && parent.category === "chama") || (child.trancheChild && parent.tranchePlan)) return [];
  const out: string[] = [];
  if (child.chamaPolicy || child.trancheChild) out.push("kind");
  if (child.category !== parent.category) out.push("category");
  // Units are counted as stock counts them, so price and stock always agree.
  if (child.amountMsats !== parent.amountMsats * childClaim(child)) out.push("price");
  if (child.mintUrl.trim() !== parent.mintUrl.trim()) out.push("federation");
  const pool = (list: readonly string[]) => [...new Set(list.map((pk) => pk.toLowerCase()))].sort().join(",");
  if (pool(child.communityArbiters) !== pool(parent.communityArbiters)) out.push("arbiters");
  const seller = parent.participants[Role.SELLER];
  if (!seller || child.participants[Role.SELLER]?.toLowerCase() !== seller.toLowerCase()) out.push("seller");
  return out;
}

/** The parent's children whose terms are the listing's (audit M3). */
export function matchingChildren(parent: EscrowState, children: readonly EscrowState[]): EscrowState[] {
  return children.filter((child) => child.parent === parent.id && storefrontChildMismatches(parent, child).length === 0);
}

/** Units a child claims (defaults to 1 for legacy / malformed values, so a
 *  child can never silently free or over-consume stock). */
function childClaim(child: EscrowState): number {
  const q = child.claimedQuantity;
  return typeof q === "number" && Number.isInteger(q) && q > 0 ? q : 1;
}

function sumClaims(
  parent: EscrowState,
  children: readonly EscrowState[],
  predicate: (child: EscrowState) => boolean,
): number {
  let units = 0;
  // M3: a child whose terms aren't the listing's is not an order, so it
  // neither holds nor sells a unit.
  for (const child of matchingChildren(parent, children)) {
    if (predicate(child)) units += childClaim(child);
  }
  return units;
}

/** Units a NEW buyer can take right now: `stock − (held + locked units)`,
 *  floored at 0. A parent with no `stock` is the legacy single unit. */
export function remainingStock(
  parent: EscrowState,
  children: readonly EscrowState[],
  now: number,
): number {
  const total = parent.stock ?? 1;
  return Math.max(0, total - sumClaims(parent, children, (c) => childCommitsStock(c, now)));
}

/** Units not yet LOCKED — held units still count. The listing stays browsable
 *  while this is > 0; it's sold out only when every unit is locked. */
export function unsoldStock(
  parent: EscrowState,
  children: readonly EscrowState[],
  now: number,
): number {
  const total = parent.stock ?? 1;
  return Math.max(0, total - sumClaims(parent, children, childIsLocked));
}

/** Fully sold: every unit is locked, nothing left to buy. Browse hides these. */
export function isSoldOut(
  parent: EscrowState,
  children: readonly EscrowState[],
  now: number,
): boolean {
  return unsoldStock(parent, children, now) <= 0;
}

/** The #7 "last unit" gate: exactly one unit is unsold AND it's currently
 *  held (so nothing is buyable right now) — i.e. the "1 left, being viewed by
 *  another buyer, Ns left" countdown should show to would-be buyers. */
export function isLastUnitContested(
  parent: EscrowState,
  children: readonly EscrowState[],
  now: number,
): boolean {
  return (
    unsoldStock(parent, children, now) === 1 &&
    remainingStock(parent, children, now) === 0
  );
}

/** Children that are OVERSOLD — LOCKED beyond the parent's stock by lock order
 *  (the Option A overcommit from a last-unit race). The first `stock` units'
 *  worth of locked children, ordered by lock time, are honored; any later
 *  locked child that would push the delivered total past `stock` is oversold and
 *  should be refunded. Only the SELLER can compute this — they're a participant
 *  in every child and can decrypt each lock to see its status + time. Pure.
 *
 *  Held-but-unlocked children are NOT counted (no sats committed yet). A child
 *  already refunded (CANCELLED/EXPIRED) drops out, so refunding an oversold one
 *  frees its slot and the list shrinks on the next pass. Multi-unit children are
 *  atomic: a child that would straddle the boundary is refunded whole (never
 *  partially oversold), so the storefront can never deliver more than `stock`. */
export function overcommittedChildren(
  parent: EscrowState,
  children: readonly EscrowState[],
): EscrowState[] {
  const stock = parent.stock ?? 1;
  const locked = matchingChildren(parent, children)
    .filter((c) => childIsLocked(c))
    .sort((a, b) => (a.lock.lockedAt ?? a.createdAt) - (b.lock.lockedAt ?? b.createdAt));
  const oversold: EscrowState[] = [];
  let delivered = 0;
  for (const child of locked) {
    const q = childClaim(child);
    if (delivered + q > stock) oversold.push(child);
    else delivered += q;
  }
  return oversold;
}

// ── Child spawn (Stage 2b) ────────────────────────────────────────────────
// Turning a multi-unit parent listing + a desired quantity into the params for
// the buyer's child CREATE. Pure: no relays, no money — it just maps the
// parent's terms onto a fresh child, prices it per-unit × quantity, and seats
// the parent's seller so the buyer-created child is lock-ready under Option A.

/** Params for a child purchase CREATE — a structural subset of
 *  EscrowClient.createEscrow's params, carrying the storefront link. */
export interface ChildCreateParams {
  description: string;
  imageDataUrl?: string;
  imageUrls?: string[];
  amountMsats: number;
  fiatAmount?: number;
  fiatCurrency?: string;
  premiumBps?: number;
  category: string;
  fulfillment?: "physical" | "service" | "digital";
  community?: string;
  /** v3.1 B3: ISO country carried from the parent so children self-describe too. */
  country?: string;
  mintUrl: string;
  paymentMethods?: string[];
  arbiterFeeMsats?: number;
  communityArbiters?: string[];
  /** Parent listing id — also emitted as a `#parent` tag for child fan-out. */
  parent: string;
  /** Units this child claims from the parent's stock. */
  claimedQuantity: number;
  /** Parent's seller, seated as SELLER so the buyer-created child can LOCK. */
  sellerPubkey: string;
}

/** Build the createEscrow params for a CHILD purchase of `claimedQuantity`
 *  units from a multi-unit parent listing. Per-unit price (and fiat) scale by
 *  quantity; the flat arbiter fee does not (one child = one escrow). Throws on
 *  a malformed parent or quantity — spawning a child from a non-listing or
 *  with a bad count is a programming error, never a silent half-formed escrow.
 *  Money safety is unaffected regardless: every child is its own 2-of-3 escrow. */
export function buildChildCreateParams(
  parent: EscrowState,
  claimedQuantity: number,
): ChildCreateParams {
  if (!Number.isInteger(claimedQuantity) || claimedQuantity <= 0) {
    throw new Error(`buildChildCreateParams: claimedQuantity must be a positive integer (got ${claimedQuantity})`);
  }
  if (parent.category !== "marketplace") {
    throw new Error(`buildChildCreateParams: only marketplace listings spawn children (parent is ${parent.category})`);
  }
  if (parent.parent !== undefined) {
    throw new Error("buildChildCreateParams: cannot spawn a child of a child");
  }
  const sellerPubkey = parent.participants[Role.SELLER];
  if (!sellerPubkey) {
    throw new Error("buildChildCreateParams: parent listing has no seller to buy from");
  }
  return {
    description: parent.description,
    ...(parent.imageDataUrl ? { imageDataUrl: parent.imageDataUrl } : {}),
    ...(parent.imageUrls?.length ? { imageUrls: [...parent.imageUrls] } : {}),
    amountMsats: parent.amountMsats * claimedQuantity,
    ...(parent.fiatAmount !== undefined ? { fiatAmount: parent.fiatAmount * claimedQuantity } : {}),
    ...(parent.fiatCurrency !== undefined ? { fiatCurrency: parent.fiatCurrency } : {}),
    ...(parent.premiumBps !== undefined ? { premiumBps: parent.premiumBps } : {}),
    category: parent.category,
    fulfillment: parent.fulfillment,
    ...(parent.community ? { community: parent.community } : {}),
    // v3.1 B3: inherit the parent's self-describing country stamp.
    ...(parent.country ? { country: parent.country } : {}),
    mintUrl: parent.mintUrl,
    ...(parent.paymentMethods ? { paymentMethods: parent.paymentMethods } : {}),
    arbiterFeeMsats: parent.fees.arbiterMsats,
    communityArbiters: parent.communityArbiters,
    parent: parent.id,
    claimedQuantity,
    sellerPubkey,
  };
}
