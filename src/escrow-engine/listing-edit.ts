// ══════════════════════════════════════════════════════════════════════════
// Chama — editing a listing (A3)
// ══════════════════════════════════════════════════════════════════════════
//
// ⭐ THERE IS NO EDIT EVENT, AND THERE SHOULD NOT BE.
//
// A listing is a CREATE on a signed, replayable chain. The reducer's only legal
// exit from CREATED short of a lock is CANCEL — deliberately, because an event
// that could rewrite a live offer's terms would let a seller change the price
// out from under a buyer mid-join, and every client replaying the chain would
// have to decide which version the buyer agreed to. So an edit is not a
// mutation. It is a REPLACEMENT: publish a fresh CREATE carrying the new terms,
// then CANCEL the old one.
//
// That is the same shape renewal already uses (listing-renewal.ts), which is
// why this module is small — `buildRenewCreateParams` does the rebuild, and
// this only applies the seller's changes on top.
//
// ORDER MATTERS, and it is create-then-cancel. If the CANCEL fails after the
// new listing is published, the seller has a duplicate they can delete, and the
// stale one lapses within its ~24h window anyway since it is retired locally
// and will never auto-renew. If we cancelled first and the CREATE failed, the
// seller would have no storefront at all. A recoverable duplicate beats a
// vanished shop.
//
// This module is PURE: no relays, no money, no reducer touch.

import { EscrowStatus, Role, type EscrowState } from "./types.js";
import { buildRenewCreateParams, type RenewCreateParams } from "./listing-renewal.js";
import { isSellerOwnedListing, listingNeverFunded } from "./listing-renewal.js";

/** What a seller may change on a live listing.
 *
 *  Deliberately NOT here: `category`, `community`, `mintUrl`, `subscription`.
 *  Those decide which vertical the offer lives in, which chama it belongs to,
 *  and which federation's money backs it. Changing one is not an edit of this
 *  offer, it is a different offer — and quietly moving a listing between
 *  federations is a money-path surprise. Delete and re-create instead. */
export interface ListingEdits {
  description?: string;
  amountMsats?: number;
  fiatAmount?: number;
  fiatCurrency?: string;
  paymentMethods?: string[];
  fulfillment?: "physical" | "service" | "digital";
  billType?: string;
  stock?: number;
  imageDataUrl?: string;
  imageUrls?: string[];
}

export type ListingEditRefusal =
  | "not-owner"
  | "not-a-listing"
  | "already-funded"
  | "buyer-holding"
  | "no-changes";

export type ListingEditCheck =
  | { ok: true }
  | { ok: false; reason: ListingEditRefusal };

/** Does any buyer currently hold a seat on this listing?
 *
 *  ⚠ This is the fairness gate, and it is the reason this module exists rather
 *  than a one-line republish. A join hold is a buyer's reservation at the terms
 *  they saw. Re-publishing under them would move the price after they committed
 *  to it — and because an edit is a replacement, their hold would point at a
 *  listing that no longer exists. Holds are short (minutes); the seller waits. */
export function listingHasLiveHold(state: EscrowState, nowSec: number): boolean {
  const holds = state.joinHolds;
  if (!holds) return false;
  for (const role of [Role.BUYER, Role.SELLER, Role.ARBITER]) {
    const hold = holds[role];
    if (hold && hold.expiresAt > nowSec) return true;
  }
  return false;
}

/** Whether the seller may edit this listing right now, and why not if not. */
export function canEditListing(
  state: EscrowState,
  userPubkey: string | null,
  nowSec: number,
): ListingEditCheck {
  if (state.parent !== undefined) return { ok: false, reason: "not-a-listing" };
  if (!isSellerOwnedListing(state, userPubkey)) return { ok: false, reason: "not-owner" };
  // An edit re-publishes; a funded trade must never be re-published, because
  // the sats are committed against the terms the buyer locked to.
  if (!listingNeverFunded(state)) return { ok: false, reason: "already-funded" };
  if (state.status !== EscrowStatus.CREATED) return { ok: false, reason: "not-a-listing" };
  if (listingHasLiveHold(state, nowSec)) return { ok: false, reason: "buyer-holding" };
  return { ok: true };
}

/** True when the edits would actually change something. A no-op edit still
 *  costs a CREATE and a CANCEL on every relay, and leaves the seller's own
 *  listing id churning for no reason, so it is refused rather than performed. */
export function editsAreMeaningful(state: EscrowState, edits: ListingEdits): boolean {
  const differs = <T,>(next: T | undefined, current: T): boolean =>
    next !== undefined && next !== current;
  if (differs(edits.description?.trim(), state.description)) return true;
  if (differs(edits.amountMsats, state.amountMsats)) return true;
  if (differs(edits.fiatAmount, state.fiatAmount)) return true;
  if (differs(edits.fiatCurrency, state.fiatCurrency)) return true;
  if (differs(edits.fulfillment, state.fulfillment)) return true;
  if (differs(edits.billType, state.billType)) return true;
  if (differs(edits.stock, state.stock)) return true;
  if (differs(edits.imageDataUrl, state.imageDataUrl)) return true;
  if (edits.paymentMethods !== undefined
    && JSON.stringify(edits.paymentMethods) !== JSON.stringify(state.paymentMethods ?? [])) return true;
  if (edits.imageUrls !== undefined
    && JSON.stringify(edits.imageUrls) !== JSON.stringify(state.imageUrls ?? [])) return true;
  return false;
}

/** Rebuild the replacement listing's CREATE params: the original's terms with
 *  the seller's changes applied.
 *
 *  Inherits `buildRenewCreateParams`'s guarantees — notably that it stamps NO
 *  `expirySeconds`, so an edited listing gets the same short default window as
 *  a fresh publish and a locked trade's timeout is never extended. */
export function buildEditCreateParams(
  state: EscrowState,
  edits: ListingEdits,
): RenewCreateParams {
  const base = buildRenewCreateParams(state);
  const description = edits.description?.trim();
  return {
    ...base,
    ...(description ? { description } : {}),
    ...(edits.amountMsats !== undefined ? { amountMsats: edits.amountMsats } : {}),
    ...(edits.fiatAmount !== undefined ? { fiatAmount: edits.fiatAmount } : {}),
    ...(edits.fiatCurrency !== undefined ? { fiatCurrency: edits.fiatCurrency } : {}),
    ...(edits.paymentMethods !== undefined ? { paymentMethods: [...edits.paymentMethods] } : {}),
    ...(edits.fulfillment !== undefined ? { fulfillment: edits.fulfillment } : {}),
    ...(edits.billType !== undefined ? { billType: edits.billType } : {}),
    ...(edits.stock !== undefined ? { stock: edits.stock } : {}),
    ...(edits.imageDataUrl !== undefined ? { imageDataUrl: edits.imageDataUrl } : {}),
    ...(edits.imageUrls !== undefined ? { imageUrls: [...edits.imageUrls] } : {}),
  };
}
