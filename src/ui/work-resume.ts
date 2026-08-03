import { Role, type EscrowState } from "../escrow-engine/types.js";

/** Any Work listing, either side. Use this wherever the question is "is this a
 *  Work listing at all" — the vertical filter, the category chip, the renewal
 *  lane. Reserve the narrower `isWorkOffer` / `isWorkRequest` for the places
 *  where the SIDE actually changes behaviour, which is fewer than it looks. */
export function isWorkListing(state: Pick<EscrowState, "listingKind">): boolean {
  return state.listingKind === "work" || state.listingKind === "work-request";
}

/** A worker's offer: "I can do this." */
export function isWorkOffer(state: Pick<EscrowState, "listingKind">): boolean {
  return state.listingKind === "work";
}

/** A client's want-ad: "I need this done." */
export function isWorkRequest(state: Pick<EscrowState, "listingKind">): boolean {
  return state.listingKind === "work-request";
}

/** Resolve the economic worker, not merely the event author. This remains
 * correct if a future Work order is buyer-authored like storefront children. */
export function workerPubkeyForListing(listing: EscrowState): string | null {
  return listing.participants[Role.SELLER]
    ?? (listing.initiator.role === Role.SELLER ? listing.initiator.pubkey : null);
}

/** A worker résumé is derived from public live offers. No profile database and
 * no mandatory taxonomy: publishing work is enough to create the résumé. */
export function workOffersForWorker(
  listings: readonly EscrowState[],
  workerPubkey: string,
): EscrowState[] {
  const wanted = workerPubkey.toLowerCase();
  const seen = new Set<string>();
  return listings.filter(listing => {
    if (!isWorkOffer(listing) || seen.has(listing.id)) return false;
    const worker = workerPubkeyForListing(listing);
    if (worker?.toLowerCase() !== wanted) return false;
    seen.add(listing.id);
    return true;
  });
}
