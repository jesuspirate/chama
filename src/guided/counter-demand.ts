// ══════════════════════════════════════════════════════════════════════════
// Chama — Assisted Chama canvas: counter-demand counts (A5 · S2)
// ══════════════════════════════════════════════════════════════════════════
//
// The number beside each choice on the canvas: "how many people are already
// waiting for the opposite of this?"
//
// Pure. Takes listings the caller has already loaded — no relay reads, no
// async, no fetching. Same discipline as `match-listings.ts`, and for the same
// reason: a count that quietly triggers network I/O becomes a count that is
// sometimes wrong, sometimes slow, and impossible to test.
//
// ⭐ WHY THIS MODULE IS ALLOWED TO BE STRICT
//
// This number is the first quantitative claim Chama makes to a stranger. If it
// says 3 and there is really 1, the user learns in ninety seconds that the app
// inflates things, and nothing after that lands. So every rule here errs toward
// UNDERCOUNTING: a listing is counted only if the viewer could act on it right
// now. Expired, reserved, own, sold-out, wrong community — all excluded, and
// none of them "counted anyway because it might free up".
//
// The honest zero matters more than the impressive number.

import { EscrowStatus, Role, type EscrowState } from "../escrow-engine/types.js";
import { matchableVerticalsFor, type CanvasAsset, type CanvasVertical } from "./canvas-routing.js";

/** Everything a count needs about one listing. Mirrors `GuidedListingInput`'s
 *  shape — the caller supplies derived facts, this module derives nothing. */
export interface CounterDemandListing {
  listing: EscrowState;
  /** From the storefront accountant, for multi-unit listings. Omit otherwise. */
  availableUnits?: number;
}

export interface CounterDemandContext {
  /** The viewer, so their own listings never inflate their own count. */
  viewerPubkey: string | null;
  /** Community scope. The canvas says "within your community", so a listing
   *  from elsewhere is not something the viewer was offered. */
  community: string | null;
  /** Seconds. Injected so expiry is testable and never reads the clock. */
  nowSec: number;
}

/** Why a listing did not count. Kept so a "0" can always be explained rather
 *  than merely asserted. */
export type CounterDemandExclusion =
  | "wrong-vertical"
  | "not-open"
  | "child-order"
  | "expired"
  | "own-listing"
  | "reserved"
  | "out-of-stock"
  | "other-community";

export interface CounterDemandResult {
  count: number;
  listingIds: readonly string[];
  excluded: readonly { listingId: string; reason: CounterDemandExclusion }[];
}

/** A listing's vertical, as the canvas understands it. */
function verticalOf(listing: EscrowState): CanvasVertical | null {
  const c = listing.category;
  return c === "p2p-trade" || c === "bill-pay" || c === "marketplace" || c === "work"
    ? c
    : null;
}

/** Who owns this listing — the initiator, falling back to the seated seller. */
function authorOf(listing: EscrowState): string | null {
  return listing.initiator?.pubkey ?? listing.participants?.[Role.SELLER] ?? null;
}

/**
 * Count listings a viewer bringing `bring` and wanting `want` could act on now.
 *
 * ⚠ Returns ZERO on the publish side, by construction — `matchableVerticalsFor`
 * yields no verticals there. A person selling sats is not served by other
 * people selling sats: those are competitors, not counterparties. Showing them
 * "3 waiting" would be the single most misleading number in the product.
 */
export function countCounterDemand(
  bring: CanvasAsset,
  want: CanvasAsset,
  listings: readonly CounterDemandListing[],
  ctx: CounterDemandContext,
): CounterDemandResult {
  const wanted = matchableVerticalsFor(bring, want);
  const listingIds: string[] = [];
  const excluded: { listingId: string; reason: CounterDemandExclusion }[] = [];

  // Publish side: nothing to count and nothing to explain. Returning early
  // keeps the exclusion list meaningful — every listing would otherwise be
  // reported as "wrong-vertical", which is true but useless.
  if (wanted.length === 0) return { count: 0, listingIds: [], excluded: [] };

  for (const entry of listings) {
    const l = entry.listing;
    const id = l.id;
    const drop = (reason: CounterDemandExclusion) => excluded.push({ listingId: id, reason });

    const vertical = verticalOf(l);
    if (!vertical || !wanted.includes(vertical)) { drop("wrong-vertical"); continue; }

    // Only a live, unlocked offer is actionable. Anything past CREATED is
    // somebody else's trade.
    if (l.status !== EscrowStatus.CREATED) { drop("not-open"); continue; }

    // A child order is one buyer's in-flight purchase from a storefront, not an
    // offer open to the viewer.
    if (l.parent) { drop("child-order"); continue; }

    if (l.expiresAt !== null && l.expiresAt !== undefined && l.expiresAt <= ctx.nowSec) {
      drop("expired"); continue;
    }

    const author = authorOf(l);
    if (ctx.viewerPubkey && author && author.toLowerCase() === ctx.viewerPubkey.toLowerCase()) {
      drop("own-listing"); continue;
    }

    // "Within your community" — the canvas's own words, so the count must mean
    // exactly that. A listing with no community is treated as global and counts.
    if (ctx.community && l.community && l.community !== ctx.community) {
      drop("other-community"); continue;
    }

    // Someone holds this seat right now. It may free up; it is not available
    // now, and "now" is what the number claims.
    const hold = l.joinHolds?.[Role.BUYER];
    if (hold && hold.expiresAt > ctx.nowSec) { drop("reserved"); continue; }

    if (entry.availableUnits !== undefined && entry.availableUnits <= 0) {
      drop("out-of-stock"); continue;
    }

    listingIds.push(id);
  }

  return { count: listingIds.length, listingIds, excluded };
}

/**
 * The canvas's Q1 row: for a fixed `want`, how many people are waiting behind
 * each thing the user might bring.
 *
 * Publish-side choices come back 0 — which is not a gap in the data but the
 * invitation to be first, and the UI must render it as "none yet" rather than
 * hiding the row.
 */
export function counterDemandByAsset(
  want: CanvasAsset,
  listings: readonly CounterDemandListing[],
  ctx: CounterDemandContext,
): Record<CanvasAsset, number> {
  const assets: CanvasAsset[] = ["sats", "cash", "work", "goods"];
  const out = {} as Record<CanvasAsset, number>;
  for (const bring of assets) {
    out[bring] = countCounterDemand(bring, want, listings, ctx).count;
  }
  return out;
}
